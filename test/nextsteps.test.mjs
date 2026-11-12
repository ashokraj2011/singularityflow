import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { nextStepsSnapshot, nextStepsText, workflowNextSteps } from '../src/nextsteps.mjs';
import { agentNextSteps, storyPrerequisites, snapshotContinuation } from '../src/commands/nextsteps.mjs';
import { copilotAction } from '../src/copilot-guidance.mjs';

/** Intake as the Story's last step, which nobody approves: submitting it ends the Story. */
function endingWorkflow(options) {
  const state = workflow(options);
  state.phaseOrder = ['intake'];
  state.phases.intake.approvalPolicy = { mode: 'none' };
  return state;
}

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
  // Rejection waits for submission: offered while the step awaits approval, never before.
  assert.deepEqual(steps.map((item) => item.skill), ['/sf-phase', '/sf-publish', '/sf-submit', '/sf-approve', '/sf-cancel', '/sf-phase']);
  assert.deepEqual(steps.map((item) => item.timing), ['now', 'then', 'then', 'then', 'alternative', 'then']);
  assert.equal(steps.some((item) => item.command.startsWith('singularity-flow reject')), false);
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
  // Its next draft for a change the person asks for, in the same step, as for code.
  assert.equal(generated[1].command, 'singularity-flow phase rollover intake --reason "<what to change>" --json');
  assert.equal(generated[1].timing, 'alternative');
  assert.equal(generated[2].skill, '/sf-phase-documents');
  assert.equal(generated[2].timing, 'alternative');
  assert.equal(generated[2].copilotCommand, '/sf-phase-documents intake');
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

test('a pending prepare renders the next generation\'s inputs, so no separate input action precedes it', () => {
  const story = workflow({ generation: 1 });
  story.phases.intake.rejectedAt = '2026-10-02T00:00:00.000Z';
  story.phases.intake.generationHighWatermark = 2;
  story.resolution = { inputsMode: 'enforce', phases: [{ id: 'intake', inputs: [{ phase: 'prior' }] }] };
  for (const generation of [2, 3]) {
    story.phases.intake.inputContext = { generation };
    const steps = workflowNextSteps(story);
    assert.equal(steps[0].command, 'singularity-flow prepare intake', `inputs rendered for generation ${generation}`);
    assert.equal(steps.some((entry) => entry.command === 'singularity-flow inputs intake'), false);
  }
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
  assert.deepEqual(completed.map((item) => item.skill), ['/sf-gate', '/sf-pr', '/sf-pr', '/sf-progress', '/sf-report']);
  // Every pull-request step carries its Shell route; none renders as "not safe to display".
  assert.doesNotMatch(nextStepsText(nextStepsSnapshot({ workflow: complete })), /not safe to display/);
  for (const host of [null, { provider: 'gitlab', label: 'GitLab' }]) {
    for (const item of workflowNextSteps(complete, { repositoryHost: host }).filter((entry) => entry.command.startsWith('singularity-flow pr '))) {
      assert.equal(item.copilotCommand, '/sf-pr', item.command);
      assert.ok(item.argv?.[0] === 'pr', item.command);
    }
  }
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

test('nextsteps text shows each action as its timing and label, its Copilot, Shell and model-free routes right under it', () => {
  const snapshot = nextStepsSnapshot({ workflow: workflow() });
  const text = nextStepsText(snapshot);
  assert.match(text, /NEXT-1 — next actions/);
  assert.match(text, /Guided router:\n- Copilot: \/sf-next\n- Shell: singularity-flow next\n- VS Code \(model-free\): not available for this action/);
  assert.match(text, /Now — Write the [^\n]*\n   - Copilot: \/sf-phase\n   - Shell: singularity-flow prepare intake\n   - VS Code \(model-free\): not available for this action\n/);
  assert.match(text, /Then — Publish the [^\n]*\n   - Copilot: \/sf-publish intake\n   - Shell: singularity-flow phase publish intake --authored governed-agent --channel copilot-host\n   - VS Code \(model-free\): @sflow \/publish intake\n/);
  assert.match(text, /Then — Submit the [^\n]* for approval\n   - Copilot: \/sf-submit\n   - Shell: singularity-flow submit intake\n   - VS Code \(model-free\): @sflow \/submit intake\n/);
  assert.doesNotMatch(text, /singularity-flow reject/, 'rejection is offered once the step awaits approval');
  assert.match(nextStepsText(nextStepsSnapshot({ workflow: workflow({ generation: 1, phaseStatus: 'awaiting_approval' }) })),
    /Or — Return the [^\n]* for correction\n   - Copilot: \/sf-reject\n   - Shell: singularity-flow reject/);
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

test('compact routing folds composition only into entry-capable authoring; other gates and custom skills survive', () => {
  const state = workflow();
  const compose = { timing: 'now', command: 'singularity-flow wm compose --phase intake',
    route: 'grounding-composition' };
  // Where the step's own route is prepare, which composes the prompt itself, composing is no step of its own (owner, 2026-11-11).
  const prepared = nextStepsSnapshot({ workflow: state, prerequisites: [compose] });
  assert.equal(prepared.actions.some((action) => action.route === 'grounding-composition'), false);
  assert.equal(prepared.actions[0].copilotCommand, '/sf-phase');
  // A compose route that does lead (another caller's) is still folded into an entry-capable authoring skill for an agent.
  const snapshot = { ...prepared, actions: [copilotAction(compose), ...prepared.actions] };
  const projected = agentNextSteps(snapshot);
  assert.equal(projected.actions.some(action => action.route === 'grounding-composition'), false);
  assert.equal(projected.actions[0].copilotCommand, '/sf-phase');
  assert.deepEqual(projected.preparation.actions, [snapshot.actions[0]]);
  assert.equal(snapshot.actions[0].route, 'grounding-composition', 'projection cannot mutate full routing');
  assert.equal(snapshotContinuation(state, projected).nextAction, projected.actions[0]);
  const withDraftingSkill = (copilotCommand) => ({ ...snapshot, actions: snapshot.actions.map(action => action.argv?.[0] === 'prepare'
    ? { ...action, copilotCommand } : action) });
  // A selectable drafting skill (the authoring-skill catalog) composes on entry like /sf-phase.
  assert.equal(agentNextSteps(withDraftingSkill('/sf-design')).actions.some(action => action.route === 'grounding-composition'), false);
  for (const copilotCommand of ['/sf-verify', '/sf-custom-draft']) {
    const custom = withDraftingSkill(copilotCommand);
    assert.equal(agentNextSteps(custom), custom, 'skills outside the authoring catalog need their own explicit compose route');
  }
  const integrity = { ...snapshot, actions: [{ ...snapshot.actions[0], route: 'integrity-repair' }, ...snapshot.actions.slice(1)] };
  assert.equal(agentNextSteps(integrity), integrity);
  const foreign = { ...snapshot, actions: [{ ...snapshot.actions[0],
    command: 'singularity-flow wm compose --phase planning' }, ...snapshot.actions.slice(1)] };
  assert.equal(agentNextSteps(foreign), foreign, 'composition must match the active phase');
  const invalid = { ...snapshot, actions: [{ ...snapshot.actions[0],
    command: 'singularity-flow wm compose --phase intake; echo injected' }, ...snapshot.actions.slice(1)] };
  assert.equal(agentNextSteps(invalid), invalid, 'unsafe presentation cannot become inline preparation');
  // Only where this step's submission ends the Story does the delivery lead, and authoring follow it [PHR:REQ-003].
  const held = nextStepsSnapshot({ workflow: endingWorkflow(), prerequisites: [compose],
    stepActionHold: { missing: [{ action: 'audit' }], nextAction: 'singularity-flow integrations status --all' } });
  assert.equal(agentNextSteps(held), held, 'a held THEN authoring action cannot swallow a prerequisite');
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
  story.phases[second].generationPublications = [{ generation: 1, record: { path: 'context/published-gen1.json' } }];
  const retained = await storyPrerequisites(root, story,
    { location: { path: 'singularity/work-items/GROUND-1/workflow.json' } }, { enabled: false });
  assert.equal(retained.some(entry => entry.skill === '/sf-resume' || /agents (?:lock|sync|refresh-output)/u.test(entry.command)),
    false, 'a published generation needs submission, not author setup or refreshed remote drafting inputs');
  // A downstream step reopened by a return to an earlier step has no rejectedAt of its own.
  const reopened = structuredClone(story);
  reopened.phases[second].reworkRevalidation = { generation: 1, invalidatedAt: '2026-10-02T00:00:00.000Z' };
  assert.equal(await grounding(reopened), true);
  const amended = structuredClone(story);
  amended.phases[second].skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: 1 };
  assert.equal(await grounding(amended), true);
  // The step's checkpoint is required: an agent-authored generation must record its clarification,
  // which is bound to the composed prompt, so composing is not optional there.
  const compose = async (enabled) => (await storyPrerequisites(root, reopened,
    { location: { path: 'singularity/work-items/GROUND-1/workflow.json' } }, { enabled }))
    .find((entry) => entry.route === 'grounding-composition');
  const withModel = await compose(true);
  assert.equal(withModel.timing, 'now');
  assert.match(withModel.reason, /clarification is recorded against that prompt/);
  const withoutModel = await compose(false);
  assert.equal(withoutModel.timing, 'optional', 'a human-authored step publishes without the record');
  assert.match(withoutModel.reason, /recording a clarification answer needs it first/);
});

test('a required after-step delivery comes first only where the next submission ends the Story [PHR:REQ-003]', () => {
  const key = `sad_${'2'.repeat(40)}`;
  const hold = {
    missing: [{ key, phaseId: 'intake', generation: 1, action: 'audit', target: 'audit-log', here: 'failed' }],
    nextAction: `singularity-flow integrations retry ${key}`,
    reason: 'The next step waits: the required after-step action audit → audit-log has no receipt in the Story.'
  };
  const plain = workflowNextSteps(workflow());
  assert.equal(plain.find((entry) => entry.command === 'singularity-flow prepare intake')?.timing, 'now');
  // A step a person approves is not held: its own work stays first, and only the ending waits for the receipt.
  assert.deepEqual(workflowNextSteps(workflow(), { stepActionHold: hold }), plain);
  const held = workflowNextSteps(endingWorkflow(), { stepActionHold: hold });
  assert.deepEqual([held[0].timing, held[0].command, held[0].skill, held[0].reason], ['now', hold.nextAction, '/sf-integrations', hold.reason]);
  assert.equal(held.find((entry) => entry.command === 'singularity-flow prepare intake')?.timing, 'then', 'the step\'s own work follows the delivery');
  assert.equal(held.filter((entry) => entry.timing === 'now').length, 1);
  const snapshot = nextStepsSnapshot({ workflow: endingWorkflow(), stepActionHold: hold });
  assert.equal(snapshot.stepActionHold, hold);
  assert.equal(snapshot.actions[0].command, hold.nextAction);
  assert.match(nextStepsText(snapshot), /integrations retry sad_2{40}/);
  assert.equal(workflowNextSteps(endingWorkflow({ phaseStatus: 'awaiting_approval', generation: 1 }), { stepActionHold: hold })[0].command.includes('integrations'), false, 'a step in review is not held');
});

test('unmet MCP readiness names its setup, in order, as NOW instead of a prepare that would refuse', () => {
  const mcpHold = {
    phase: 'intake',
    errors: ['MCP server \'playwright\' has no Story-pinned authorized origin.', 'MCP server \'playwright\' has no successful live smoke receipt.'],
    actions: [
      { command: 'singularity-flow story target-origin NEXT-1 --url <AUTHORIZED-URL>', label: 'Pin the authorized target origin to this Story.' },
      { command: 'singularity-flow mcp smoke playwright --url <AUTHORIZED-URL>', label: 'Run a live smoke of playwright.' }
    ]
  };
  const held = workflowNextSteps(workflow(), { mcpHold });
  assert.deepEqual(held.slice(0, 2).map((entry) => [entry.timing, entry.command]), [
    ['now', mcpHold.actions[0].command], ['then', mcpHold.actions[1].command]
  ]);
  assert.match(held[0].reason, /^MCP readiness blocks intake \(2 unmet\): Pin the authorized target origin/);
  assert.equal(held.find((entry) => entry.command === 'singularity-flow prepare intake')?.timing, 'then', 'prepare refuses until MCP readiness holds');
  assert.equal(held.filter((entry) => entry.timing === 'now').length, 1);
  const snapshot = nextStepsSnapshot({ workflow: workflow(), mcpHold });
  assert.equal(snapshot.mcpHold, mcpHold);
  assert.match(nextStepsText(snapshot), /1\. Now — MCP readiness blocks intake[\s\S]*story target-origin NEXT-1/);
  assert.equal(workflowNextSteps(workflow({ phaseStatus: 'awaiting_approval', generation: 1 }), { mcpHold })[0].command.includes('target-origin'), false, 'a step in review is not held');
  assert.equal(workflowNextSteps(workflow(), { mcpHold: { ...mcpHold, phase: 'requirements' } })[0].command.includes('target-origin'), false, 'another step\'s readiness holds nothing here');
});

test('a model-free run names the human publication route in its footers, refusals and nextsteps', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-nextsteps-model-free-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(root); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Next Steps Tester',
    SINGULARITY_FLOW_NO_MODEL: '1' };
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const run = (command, args, { status = 0 } = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    if (status != null) assert.equal(result.status, status, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return `${result.stdout}\n${result.stderr}`;
  };
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.name', 'Next Steps Tester']);
  run('git', ['config', 'user.email', 'next-steps@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Model-free fixture\n');
  run(process.execPath, [cli, 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.']); run('git', ['commit', '-q', '-m', 'Model-free fixture']);
  run('git', ['init', '-q', '--bare', '-b', 'main', path.join(directory, 'remote.git')]);
  run('git', ['remote', 'add', 'origin', path.join(directory, 'remote.git')]);
  run('git', ['push', '-q', '-u', 'origin', 'main']);
  run(process.execPath, [cli, 'start', 'FREE-1', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Model-free routes', '--description', 'Every route names the human producer.']);
  const human = 'singularity-flow phase publish intake --authored human --channel manual-in-place --no-model';
  // The refusal's "Then:" step and its route (the sequence gate's planner).
  const refused = run(process.execPath, [cli, 'submit', 'intake'], { status: null });
  assert.ok(refused.includes(`Shell: ${human}`), refused);
  // The footer printed after a lifecycle step, and the full nextsteps listing.
  const prepared = run(process.execPath, [cli, 'prepare', 'intake']);
  const listed = run(process.execPath, [cli, 'nextsteps']);
  assert.ok(listed.includes(`Shell: ${human}`), listed);
  for (const output of [refused, prepared, listed]) {
    assert.doesNotMatch(output, /--authored governed-agent|--channel copilot-host/u, output);
    assert.doesNotMatch(output, /singularity-flow reject intake/u, 'no rejection is offered before submission');
  }
});
