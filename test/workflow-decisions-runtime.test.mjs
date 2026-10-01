import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORK_TYPE = 'decide-demo';

function execute(command, args, cwd, { allowFailure = false, agent = null } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Decision Tester' };
  if (agent) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: WORK_TYPE, agent });
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);

/** A governed repository whose workflow carries a branch, an ask and a loop decision. */
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decisions-'));
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Decision Tester'], root);
  execute('git', ['config', 'user.email', 'decisions@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Decisions\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes[WORK_TYPE] = {
    label: 'Decision demo',
    phases: ['intake', 'requirements', 'design', 'implementation-spec'],
    phaseOverrides: {
      requirements: { inputs: ['intake'] },
      design: { inputs: ['intake', { phase: 'requirements', optional: true }] },
      'implementation-spec': { inputs: ['intake', 'design'] }
    },
    decisions: [
      {
        id: 'needs-requirements', after: 'intake', kind: 'branch', label: 'Does this need full requirements?',
        inputs: [{ name: 'risk', values: ['low', 'medium', 'high'] }],
        routes: [
          { id: 'risky', label: 'Risky', when: { risk: ['medium', 'high'] }, to: 'requirements' },
          { id: 'simple', label: 'Simple', to: 'design' }
        ]
      },
      {
        id: 'direction', after: 'requirements', kind: 'ask', label: 'Where next?',
        routes: [
          { id: 'continue', label: 'Continue to design', to: 'next' },
          { id: 'again', label: 'Another round', to: 'requirements' },
          { id: 'stop', label: 'Finish here', to: 'end' }
        ]
      },
      {
        id: 'until-ready', after: 'design', kind: 'loop', label: 'Rework until the design is ready',
        inputs: [{ name: 'ready', values: ['yes', 'no'] }], goal: { ready: 'yes' }, back: 'requirements', maxRounds: 1
      }
    ]
  };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  const remote = `${root}.git`;
  execute('git', ['init', '--bare', '-b', 'main', remote], root);
  execute('git', ['remote', 'add', 'origin', remote], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

const AGENTS = { intake: 'product-owner', requirements: 'product-owner', design: 'architect', 'implementation-spec': 'architect' };

async function state(root, workId) {
  return JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
}

/** Prepare, write, publish and submit one phase, as an agent working it would. */
async function work(root, workId, phaseId, submitArgs = []) {
  const agent = AGENTS[phaseId];
  const before = await state(root, workId);
  if (before.phases[phaseId].generation > 0 || phaseId !== before.phaseOrder[0]) flow(root, ['prepare', phaseId], { agent });
  const workflow = await state(root, workId);
  const file = path.join(root, 'singularity/work-items', workId, workflow.phases[phaseId].requiredArtifact.path);
  let text = await readFile(file, 'utf8');
  text = text.replace(/TODO:[^\n]*/g, 'matched evidence for AC-001 with exact file references and complete operational detail.').replace(/\bTODO\b/g, 'matched evidence');
  await writeFile(file, `${text}\nRound note ${Date.now()}.\n`);
  flow(root, ['resume', workId], { agent });
  flow(root, ['phase', 'publish', phaseId], { agent });
  return flow(root, ['submit', ...submitArgs], { agent, allowFailure: submitArgs.allowFailure });
}

test('a branch skips a phase, a loop goes back and stops at its limit, and a person chooses', async () => {
  const root = await repository();
  const workId = 'DEC-1';
  flow(root, ['start', workId, '--from-branch', 'main'], { agent: 'product-owner' });

  // The phase before a rule must record what the rule reads.
  const missing = await work(root, workId, 'intake', Object.assign([], { allowFailure: true }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--decision risk=<low\|medium\|high>/);
  const unknown = flow(root, ['submit', '--decision', 'size=big'], { agent: 'product-owner', allowFailure: true });
  assert.match(unknown.stderr, /does not record 'size'/);
  flow(root, ['submit', '--decision', 'risk=LOW'], { agent: 'product-owner' });
  let workflow = await state(root, workId);
  assert.deepEqual(workflow.phases.intake.decisionInputs.values, { risk: 'low' });
  assert.equal(workflow.schemaVersion, 12);

  flow(root, ['approve', '--yes'], { agent: 'product-owner' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'design', 'a low-risk intake skips requirements');
  assert.equal(workflow.phases.requirements.status, 'skipped');
  assert.deepEqual(workflow.phases.requirements.skippedBy, { decision: 'needs-requirements', route: 'simple' });
  assert.equal(workflow.phases.design.status, 'in_progress');
  assert.equal(workflow.decisionLog.at(-1).kind, 'forward');
  assert.equal(workflow.pendingDecision, undefined);

  // Design is not ready: the loop sends the Story back to requirements through a change request.
  await work(root, workId, 'design', ['--decision', 'ready=no']);
  flow(root, ['approve', '--yes'], { agent: 'architect' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.requirements.status, 'in_progress', 'the skipped phase runs when the loop returns to it');
  assert.equal(workflow.phases.requirements.skippedBy, undefined);
  assert.equal(workflow.phases.design.status, 'not_started');
  assert.equal(workflow.phases.design.decisionInputs, undefined, 'reopening clears the recorded values');
  assert.deepEqual(workflow.decisionRounds['until-ready'].count, 1);
  const loopRequest = workflow.changeRequests.at(-1);
  assert.equal(loopRequest.decision.id, 'until-ready');
  assert.equal(loopRequest.targetPhase, 'requirements');
  assert.match(loopRequest.comment, /goes back to Requirements until ready is yes \(round 1 of 1\)/);
  const rollForward = flow(root, ['story', 'rework', 'roll-forward', '--work-id', workId, '--json'], { agent: 'product-owner', allowFailure: true });
  assert.notEqual(rollForward.status, 0);
  assert.match(rollForward.stderr + rollForward.stdout, /chosen by decision 'until-ready'/);

  // Requirements is followed by an ask: approval pauses the Story for a person.
  await work(root, workId, 'requirements');
  flow(root, ['approve', '--yes'], { agent: 'product-owner' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.requirements.status, 'approved');
  assert.equal(workflow.pendingDecision.decision, 'direction');
  assert.equal(workflow.pendingDecision.reason, 'ask');
  flow(root, ['validate'], { agent: 'product-owner' });
  const shown = JSON.parse(flow(root, ['decision', 'show', '--json'], { agent: 'product-owner' }).stdout);
  assert.equal(shown.pending.key, workflow.pendingDecision.key);
  assert.deepEqual(shown.pending.options.map((option) => [option.id, option.reach]), [['continue', 'next'], ['again', 'backward'], ['stop', 'end']]);
  const stale = flow(root, ['decision', 'choose', '--option', 'continue', '--reason', 'Ready', '--expected', '0000000000000000'], { agent: 'product-owner', allowFailure: true });
  assert.match(stale.stderr, /changed after it was shown/);
  const noReason = flow(root, ['decision', 'choose', '--option', 'continue'], { agent: 'product-owner', allowFailure: true });
  assert.match(noReason.stderr, /Say why with --reason/);
  flow(root, ['decision', 'choose', '--option', 'continue', '--reason', 'Requirements are settled', '--expected', shown.pending.key], { agent: 'product-owner' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'design');
  assert.equal(workflow.pendingDecision, undefined);
  assert.equal(workflow.decisionLog.at(-1).by, 'person');
  assert.equal(workflow.decisionLog.at(-1).comment, 'Requirements are settled');

  // The loop's single round is used: a not-ready design now waits for a person instead of looping.
  await work(root, workId, 'design', ['--decision', 'ready=no']);
  flow(root, ['approve', '--yes'], { agent: 'architect' });
  workflow = await state(root, workId);
  assert.equal(workflow.pendingDecision.reason, 'limit');
  assert.equal(workflow.currentPhase, 'design');
  flow(root, ['decision', 'choose', '--option', 'goal-met', '--reason', 'Good enough for this iteration'], { agent: 'architect' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'implementation-spec');

  await work(root, workId, 'implementation-spec');
  flow(root, ['approve', '--yes'], { agent: 'architect' });
  workflow = await state(root, workId);
  assert.equal(workflow.status, 'complete');
  assert.deepEqual(workflow.decisionLog.map((entry) => [entry.decision, entry.kind, entry.by]), [
    ['needs-requirements', 'forward', 'rule'],
    ['until-ready', 'loop', 'rule'],
    ['direction', 'pause', 'person'],
    ['direction', 'next', 'person'],
    ['until-ready', 'pause', 'rule'],
    ['until-ready', 'next', 'person']
  ]);
  flow(root, ['validate'], { agent: 'architect' });
});

test('a person can finish a Story early, and the finished Story reopens from the phase that ran last', async () => {
  const root = await repository();
  const workId = 'DEC-2';
  flow(root, ['start', workId, '--from-branch', 'main'], { agent: 'product-owner' });
  await work(root, workId, 'intake', ['--decision', 'risk=high']);
  flow(root, ['approve', '--yes'], { agent: 'product-owner' });
  let workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'requirements', 'a high-risk intake keeps requirements');
  const noDecision = flow(root, ['submit', '--decision', 'risk=low'], { agent: 'product-owner', allowFailure: true });
  assert.match(noDecision.stderr, /feeds no decision that records values/);
  await work(root, workId, 'requirements');
  flow(root, ['approve', '--yes'], { agent: 'product-owner' });
  flow(root, ['decision', 'choose', '--option', 'stop', '--reason', 'Out of scope for this release'], { agent: 'product-owner' });
  workflow = await state(root, workId);
  assert.equal(workflow.status, 'complete');
  assert.equal(workflow.currentPhase, null);
  assert.deepEqual(['design', 'implementation-spec'].map((id) => workflow.phases[id].status), ['skipped', 'skipped']);
  flow(root, ['validate'], { agent: 'product-owner' });

  flow(root, ['reopen', workId, '--to', 'requirements', '--reason', 'The scope came back'], { agent: 'product-owner' });
  workflow = await state(root, workId);
  assert.equal(workflow.currentPhase, 'requirements');
  assert.deepEqual(['requirements', 'design', 'implementation-spec'].map((id) => workflow.phases[id].status), ['in_progress', 'not_started', 'not_started']);
  assert.equal(workflow.phases.design.skippedBy, undefined);
});
