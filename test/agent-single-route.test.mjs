/**
 * One way to make an agent (agent route standardization A1–A3): Workflow Studio's change set renders
 * every agent, whichever route made it, an agent with the steps it drafts is one save, one proposal
 * and one approval, and a whole-file `configuration save` never writes an agent.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { newAgentFile } from '../src/agent-file.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { STUDIO_ID } from '../src/agent-document-parser.mjs';
import { stageCandidate } from '../src/team-import/stage.mjs';
import { exportWorkflowBundle } from '../src/workflow-transfer.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const AGENT = Object.freeze({ id: 'checker', label: 'Checker', description: 'Checks every claim against its source.',
  tools: ['read', 'search'], instructions: 'Check every claim against its source, and list what you could not check.' });

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function runner(base, identity = 'Agent Author') {
  const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: identity, SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: identity,
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'agent.author@example.invalid' };
  return (cwd, args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
    if (status !== null) assert.equal(result.status, status, `singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
}

async function initialized(base, name) {
  const root = path.join(base, name);
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'README.md'), '# Agents\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
  return root;
}

const agentFile = (root) => readFile(path.join(root, '.github', 'agents', `${AGENT.id}.agent.md`), 'utf8');

// Seeded steps keep their seeded agents, so the agent drafts a step of a workflow made here.
const STEP = 'claim-check';
const stepChanges = (agent) => [
  { op: 'workflow.create', id: 'claim-review', label: 'Claim review', phases: ['intake', STEP] },
  { op: 'phase.create', id: STEP, label: 'Claim check', output: 'analysis', inputs: ['intake'], approval: { group: 'product-approvers', minimum: 1 }, agent }];
const SCRATCH = { op: 'agent.create', id: 'scratch-agent', label: 'Scratch', description: 'Holds the step until another agent takes it.', role: 'blank' };

async function apply(flow, root, base, changes, name) {
  const file = path.join(base, `${name}.json`);
  await writeFile(file, JSON.stringify({ schema: 'sflow-studio-change-set@1', changes }));
  flow(root, ['workflow', 'studio', 'apply', '--change-set', file]);
}

test('the same agent from agents create, Workflow Studio and team import is the same file, and a bundle carries it unchanged', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-route-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const flow = runner(base);

  const cliRoot = await initialized(base, 'cli');
  await apply(flow, cliRoot, base, [SCRATCH, ...stepChanges(SCRATCH.id)], 'cli-step');
  flow(cliRoot, ['agents', 'create', AGENT.id, '--label', AGENT.label, '--description', AGENT.description,
    '--tools', AGENT.tools.join(','), '--instructions', AGENT.instructions, '--step', STEP]);

  const studioRoot = await initialized(base, 'studio');
  await apply(flow, studioRoot, base, [
    { op: 'agent.create', id: AGENT.id, label: AGENT.label, description: AGENT.description, role: 'blank', tools: AGENT.tools, instructions: AGENT.instructions },
    ...stepChanges(AGENT.id)], 'studio');

  const stage = path.join(base, 'team-stage');
  await stageCandidate(stage, {
    authorities: [], templates: [], skills: [], instructions: [], attachments: [],
    phases: [{ id: STEP, label: 'Claim check', template: 'common/intake.md', artifact: { path: 'artifacts/claim-check/claim-check.md', kind: 'intake' },
      writeScope: 'artifact-only', approval: 'none', agent: AGENT.id }],
    workflow: { id: 'team-flow', label: 'Team flow', phases: [STEP] },
    agents: [{ id: AGENT.id, label: AGENT.label, description: AGENT.description, tools: AGENT.tools, body: AGENT.instructions }]
  });

  const expected = newAgentFile({ ...AGENT, phases: [STEP], defaultFor: [STEP] });
  assert.match(expected, /sflow-default-for: "claim-check"/u);
  assert.match(expected, /^# Checker agent$/mu, 'a new agent opens with its title and the shared boundary');
  assert.equal(await agentFile(cliRoot), expected, 'agents create --step');
  assert.equal(await agentFile(studioRoot), expected, 'Workflow Studio agent.create + phase.agent');
  assert.equal(await agentFile(stage), expected, 'team import');

  // An exported workflow carries the agent byte for byte; bundle import writes what the bundle carries.
  await loadDefinition(studioRoot);
  const bundle = await exportWorkflowBundle(studioRoot, ['story:claim-review']);
  assert.equal(bundle.assets.find((asset) => asset.kind === 'agent' && asset.id === AGENT.id)?.content, expected);
});

test('team import keeps its own metadata and leaves a toolless agent with every tool', async (t) => {
  const stage = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-route-team-')));
  t.after(() => rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await stageCandidate(stage, {
    authorities: [], templates: [], skills: [], instructions: [], attachments: [],
    phases: [{ id: 'plan', label: 'Plan', template: 'common/intake.md', artifact: { path: 'artifacts/plan/plan.md', kind: 'intake' }, writeScope: 'artifact-only', approval: 'none', agent: 'planner' }],
    workflow: { id: 'team-flow', label: 'Team flow', phases: ['plan'], sourceReview: { phases: ['plan'], reviewerAgent: 'plan-reviewer' } },
    agents: [
      { id: 'planner', label: 'Planner', description: 'Plans the work.', body: '# Planner\n\nPlan the work in small steps.' },
      { id: 'plan-reviewer', label: 'Plan reviewer', description: 'Reviews the plan.', tools: ['read'], body: 'Review the plan; do not edit.' }]
  });
  const planner = await readFile(path.join(stage, '.github', 'agents', 'planner.agent.md'), 'utf8');
  assert.doesNotMatch(planner, /^tools:/mu, 'no tools listed stays none listed');
  assert.match(planner, /^# Planner agent\n/mu);
  assert.doesNotMatch(planner, /^# Planner$/mu, 'the team file\'s own title gives way to the standard one');
  const reviewer = await readFile(path.join(stage, '.github', 'agents', 'plan-reviewer.agent.md'), 'utf8');
  assert.match(reviewer, /^ {2}sflow-mode: read-only-review$/mu);
  assert.match(reviewer, /sflow-phases: "plan"/u);
  assert.match(reviewer, /sflow-default-for: ""/u);
});

test('every route checks agent and step IDs with the one Studio pattern', async () => {
  const [{ validAgentId }, { validateAgentAuthoringRequest }] = await Promise.all([
    import('../src/agent-document-parser.mjs'), import('../src/commands/agent-authoring.mjs')]);
  for (const id of ['checker', 'qa-reviewer', 'a1']) assert.equal(validAgentId(id) && STUDIO_ID.test(id), true, id);
  for (const id of ['Checker', 'qa_reviewer', '-x', 'x-']) assert.equal(validAgentId(id) || STUDIO_ID.test(id), false, id);
  assert.throws(() => validateAgentAuthoringRequest({ positionals: ['agents', 'create', 'checker'], options: { step: 'Code_Review' } }),
    /--step Code_Review is not a step ID/u);
  assert.throws(() => validateAgentAuthoringRequest({ positionals: ['agents', 'create', 'checker'], options: { role: 'boss' } }),
    /--role must be one of: analyst, product-owner, architect, developer, tester, designer, reviewer, blank\./u);
});

test('an agent and the step it drafts are one save, one proposal and one approval', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-route-drafts-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const flow = runner(base);
  const seed = await initialized(base, 'seed');
  await apply(flow, seed, base, [SCRATCH, ...stepChanges(SCRATCH.id)], 'seed-step');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'A step of our own');
  const remote = path.join(base, 'remote.git');
  const checkout = path.join(base, 'laptop');
  git(base, 'clone', '-q', '--bare', seed, remote);
  flow(base, ['bootstrap', remote, '--capability', 'agents', '--into', checkout]);
  const approved = (file) => git(remote, 'show', `sflow/config:${file}`);
  assert.match(approved('.github/agents/scratch-agent.agent.md'), /sflow-default-for: "claim-check"/u, 'the step starts with the scratch agent');

  const saved = flow(checkout, ['agents', 'create', AGENT.id, '--label', AGENT.label, '--description', AGENT.description,
    '--tools', AGENT.tools.join(','), '--instructions', AGENT.instructions, '--step', STEP]).stdout;
  assert.match(saved, /Saved as a draft; no Story uses it until it is approved\. Drafts waiting: 2\./u);
  const drafts = flow(checkout, ['configuration', 'drafts']).stdout;
  assert.match(drafts, /New agent Checker \(checker\)/u);
  assert.match(drafts, /Step claim-check drafted by agent checker/u);
  assert.match(flow(checkout, ['agents', 'create', AGENT.id, '--label', AGENT.label, '--description', AGENT.description,
    '--tools', AGENT.tools.join(','), '--instructions', AGENT.instructions, '--step', STEP]).stdout, /^Already saved as a draft/u,
  'the same command again saves nothing new');

  flow(checkout, ['configuration', 'propose']);
  flow(checkout, ['configuration', 'approve', '--yes']);
  assert.match(approved('.github/agents/checker.agent.md'), /sflow-default-for: "claim-check"/u);
  assert.match(approved('.github/agents/scratch-agent.agent.md'), /sflow-default-for: ""/u, 'the step left the scratch agent in the same approval');
  assert.match(flow(checkout, ['configuration', 'drafts']).stdout, /^No drafts\./u);

  // Choosing the drafting agent of a step on its own is a draft too.
  git(checkout, 'pull', '-q', '--ff-only');
  assert.match(flow(checkout, ['agents', 'edit', 'scratch-agent', '--step', STEP]).stdout, /Drafts waiting: 1\./u);
  assert.match(flow(checkout, ['configuration', 'drafts']).stdout, /Step claim-check drafted by agent scratch-agent/u);
});

test('configuration save refuses an agent file, with or without --propose, and names the Studio route', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-route-save-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const flow = runner(base);
  const root = await initialized(base, 'save');
  flow(root, ['agents', 'create', AGENT.id, '--label', AGENT.label, '--description', AGENT.description, '--instructions', AGENT.instructions]);
  const before = await agentFile(root);
  for (const [relative, extra] of [[`.github/agents/${AGENT.id}.agent.md`, []], [`.github/agents/${AGENT.id}.agent.md`, ['--propose']], ['.github/agents/fresh.agent.md', []]]) {
    const result = flow(root, ['configuration', 'save', relative, ...extra, '--json'], null);
    assert.notEqual(result.status, 0, relative);
    assert.match(`${result.stdout}${result.stderr}`, /CONFIGURATION_AGENT_FILE_STUDIO_ONLY/u);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`agents edit ${path.basename(relative, '.agent.md')}`, 'u'));
  }
  assert.equal(await agentFile(root), before, 'nothing was saved');
  assert.equal(git(root, 'for-each-ref', 'refs/heads/sflow/config-change'), '', 'and nothing was proposed');
});
