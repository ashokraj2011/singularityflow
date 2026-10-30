import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { normalizeApmConfiguration } from '../src/apm-lock.mjs';
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';

// APM A3 (2026-10-29): an agent APM deployed into .github/agents drafts a workflow's steps. Its file
// stays exactly as APM wrote it: the steps live in workflow.yml `apm.agents`, and a Story uses it
// only while it matches apm.lock.yaml. The lock below has the shape apm 0.35.0 writes.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const env = {
  ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
  SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'repo-feature', agent: 'product-owner' })
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
function run(command, args, cwd, extra = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, ...extra } });
}
const git = (root, ...args) => {
  const result = run('git', args, root);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};
const flow = (root, args, extra) => run(process.execPath, [bin, ...args], root, extra);
const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result; };

const AGENTS = Object.freeze({
  reviewer: '---\nname: reviewer\ndescription: Reviews the change for defects\ntools: [read, search]\n---\nReview the change carefully.\n',
  // Written for Copilot only: no description, which SFlow's agents need.
  planner: '---\nname: planner\ntools: ["codebase"]\n---\nPlan the work.\n',
  // A package that names its own steps, one of them unknown here, and takes QA's default.
  eager: '---\nname: eager\ndescription: Wants every step\nmetadata:\n  sflow-phases: "verification,launch-party"\n  sflow-default-for: "verification"\n---\nDo it all.\n'
});

async function repository(t, { agents = ['reviewer'], bindings = null, lock = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-agents-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  run('git', ['init', '-q', '--bare', path.join(base, 'remote.git')], base);
  run('git', ['init', '-q', '-b', 'main', root], base);
  for (const [key, value] of [['user.name', 'Packager'], ['user.email', 'packager@example.com']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', path.join(base, 'remote.git'));
  await writeFile(path.join(root, 'README.md'), '# apm agents\n');
  ok(flow(root, ['init']));
  await repositoryOwnedWorkflows(root);
  const config = path.join(root, 'singularity/workflow.yml');
  const document = YAML.parseDocument(await readFile(config, 'utf8'));
  document.setIn(['worldModel', 'grounding'], 'off');
  if (bindings) document.set('apm', document.createNode(bindings));
  await writeFile(config, document.toString());
  const deployed = agents.map((id) => `.github/agents/${id}.agent.md`);
  for (const id of agents) await writeFile(path.join(root, `.github/agents/${id}.agent.md`), AGENTS[id]);
  await writeFile(path.join(root, 'apm.yml'), 'name: consumer\nversion: 1.0.0\ndependencies:\n  apm:\n    - ../team-agents\nx-sflow:\n  apm-cli: 0.35.0\n');
  if (lock) await writeFile(path.join(root, 'apm.lock.yaml'), YAML.stringify({
    lockfile_version: '1', apm_version: '0.35.0',
    dependencies: [{ repo_url: '_local/team-agents', name: 'team-agents', version: '1.0.0', package_type: 'apm_package',
      deployed_files: deployed, deployed_file_hashes: Object.fromEntries(agents.map((id) => [`.github/agents/${id}.agent.md`, `sha256:${sha(AGENTS[id])}`])),
      source: 'local', local_path: '../team-agents' }]
  }));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init with APM agents');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { base, root };
}

test('an agent APM deployed that SFlow cannot read is left out, never a reason configuration fails', async (t) => {
  const { root } = await repository(t, { agents: ['reviewer', 'planner'] });
  const listed = ok(flow(root, ['agents', 'list']));
  assert.match(listed.stdout, /^reviewer\s+repository/mu);
  assert.doesNotMatch(listed.stdout, /^planner\b/mu);
  const status = JSON.parse(ok(flow(root, ['apm', 'status', '--json'])).stdout);
  assert.deepEqual(status.agents.unusable.map(({ name, reason }) => [name, reason]), [['planner', "Agent 'planner' requires a non-empty description."]]);
  assert.match(ok(flow(root, ['apm', 'status'])).stdout, /SFlow cannot use agent planner \(\.github\/agents\/planner\.agent\.md, from team-agents \(local\)\)/u);

  // One written in this repository is still SFlow's to get right.
  await writeFile(path.join(root, '.github/agents/local-draft.agent.md'), '---\nname: local-draft\n---\nDraft.\n');
  const refused = flow(root, ['agents', 'list']);
  assert.match(refused.stderr + refused.stdout, /Agent 'local-draft' requires a non-empty description/u);
});

test('apm attach makes an APM agent draft a step in workflow.yml and never edits a file, and the step returns to its agent when APM\'s is gone', async (t) => {
  const { root } = await repository(t);
  const before = await readFile(path.join(root, '.github/agents/reviewer.agent.md'), 'utf8');
  const qaBefore = await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8');
  const preview = ok(flow(root, ['apm', 'attach', 'reviewer', '--step', 'verification', '--dry-run']));
  assert.match(preview.stdout, /Verification is now drafted by reviewer \(was QA\)/u);
  assert.match(preview.stdout, /changed: singularity\/workflow\.yml/u);
  assert.doesNotMatch(preview.stdout, /reviewer\.agent\.md|qa\.agent\.md/u, 'no agent file is in the change');
  ok(flow(root, ['apm', 'attach', 'reviewer', '--step', 'verification']));
  assert.equal(await readFile(path.join(root, '.github/agents/reviewer.agent.md'), 'utf8'), before, 'byte for byte as APM wrote it');
  assert.equal(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), qaBefore, 'QA keeps the step in its own file');
  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(written.apm, { agents: { reviewer: { defaultFor: ['verification'] } } });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'reviewer drafts verification');
  const drafter = () => JSON.parse(ok(flow(root, ['workflow', 'studio', '--json'])).stdout)
    .workflows.find((workflow) => workflow.id === 'repo-feature').steps.find((step) => step.id === 'verification').agent;
  assert.equal(drafter(), 'reviewer');
  assert.match(ok(flow(root, ['apm', 'status'])).stdout, /reviewer drafts verification \(workflow\.yml apm\.agents\)\./u);

  // Workflow Studio may move the step to another agent, but never edit the APM agent's own text.
  const changeSet = path.join(root, '..', 'edit-reviewer.json');
  await writeFile(changeSet, JSON.stringify({ schema: 'sflow-studio-change-set@1', changes: [{ op: 'agent.update', id: 'reviewer', description: 'Something else' }] }));
  const refused = JSON.parse(flow(root, ['workflow', 'studio', 'apply', '--change-set', changeSet, '--dry-run', '--json']).stdout);
  assert.equal(refused.valid, false);
  assert.equal(refused.problems[0].code, 'STUDIO_AGENT_APM_OWNED');
  assert.match(refused.problems[0].message, /installed by APM \(team-agents \(local\)\); change it in its package/u);
  const local = flow(root, ['apm', 'attach', 'qa', '--step', 'verification']);
  assert.notEqual(local.status, 0);
  assert.match(local.stderr + local.stdout, /qa is not an agent APM deployed/u);

  // The APM agent gone (uninstalled, or never checked out): nothing fails, and QA drafts the step again.
  await rm(path.join(root, '.github/agents/reviewer.agent.md'));
  ok(flow(root, ['agents', 'list']));
  assert.equal(drafter(), 'qa');
  assert.match(ok(flow(root, ['apm', 'status'])).stdout,
    /reviewer would draft verification \(workflow\.yml apm\.agents\), but APM did not deploy|reviewer would draft verification \(workflow\.yml apm\.agents\), but \.github\/agents\/reviewer\.agent\.md is missing/u);
  git(root, 'checkout', '-q', '--', '.github/agents/reviewer.agent.md');

  // Moving the step from the APM agent to a third agent takes it from QA's file for good.
  await writeFile(path.join(root, '.github/agents/checker.agent.md'), '---\nname: checker\ndescription: Checks the change\nmetadata:\n  sflow-phases: "verification"\n---\nCheck it.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'checker');
  const move = path.join(root, '..', 'move.json');
  await writeFile(move, JSON.stringify({ schema: 'sflow-studio-change-set@1', changes: [{ op: 'phase.agent', phase: 'verification', agent: 'checker' }] }));
  ok(flow(root, ['workflow', 'studio', 'apply', '--change-set', move, '--json']));
  assert.equal(YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')).apm, undefined);
  const qaDefaults = /sflow-default-for: "([^"\n]*)"/u.exec(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'))[1].split(',');
  assert.equal(qaDefaults.includes('verification'), false);
  assert.match(await readFile(path.join(root, '.github/agents/checker.agent.md'), 'utf8'), /sflow-default-for: "?verification/u);
});

test('APM never blocks the rest: a binding that cannot apply waits, and every command still loads', async (t) => {
  const unknown = await repository(t, { bindings: { agents: { ghost: { defaultFor: ['verification'] } } } });
  ok(flow(unknown.root, ['agents', 'list']));
  assert.match(ok(flow(unknown.root, ['apm', 'status'])).stdout, /ghost would draft verification \(workflow\.yml apm\.agents\), but APM did not deploy \.github\/agents\/ghost\.agent\.md; until then each step keeps its workflow's own agent\./u);
  const local = await repository(t, { bindings: { agents: { qa: { steps: ['verification'] } } } });
  ok(flow(local.root, ['agents', 'list']));
  const unreadable = await repository(t, { agents: ['planner'], bindings: { agents: { planner: { defaultFor: [] } } } });
  ok(flow(unreadable.root, ['agents', 'list']));
  assert.match(ok(flow(unreadable.root, ['apm', 'status'])).stdout, /planner would draft no step by default .* but SFlow cannot read \.github\/agents\/planner\.agent\.md: Agent 'planner' requires a non-empty description/u);

  // No lock at all (APM never ran here, or the lock was not committed): a Story starts, QA drafting.
  const lockless = await repository(t, { lock: false, bindings: { agents: { reviewer: { defaultFor: ['verification'] } } } });
  ok(flow(lockless.root, ['start', 'APM-9', '--from-branch', 'main']));
  const state = JSON.parse(await readFile(path.join(lockless.root, 'singularity/work-items/APM-9/workflow.json'), 'utf8'));
  assert.equal(state.resolution.phases.find((phase) => phase.id === 'verification').defaultAgent, 'qa');
  assert.match(ok(flow(lockless.root, ['apm', 'status'])).stdout, /reviewer would draft verification .* but there is no apm\.lock\.yaml/u);

  // A package's own step choices are never read: they could name steps this repository lacks or
  // give a step a second default.
  const choosy = await repository(t, { agents: ['eager'] });
  ok(flow(choosy.root, ['agents', 'list']));
  ok(flow(choosy.root, ['start', 'APM-8', '--from-branch', 'main']));
  const choosyState = JSON.parse(await readFile(path.join(choosy.root, 'singularity/work-items/APM-8/workflow.json'), 'utf8'));
  assert.equal(choosyState.resolution.phases.find((phase) => phase.id === 'verification').defaultAgent, 'qa');

  // A hand-edited apm block that cannot be read binds nothing; every command still loads.
  const garbled = await repository(t, { bindings: { agents: { reviewer: { defaultFor: 'verification' } } } });
  ok(flow(garbled.root, ['agents', 'list']));
  ok(flow(garbled.root, ['start', 'APM-7', '--from-branch', 'main']));
  assert.match(ok(flow(garbled.root, ['apm', 'status'])).stdout, /workflow\.yml apm cannot be read \(apm\.agents\.reviewer\.defaultFor must be a list of step IDs\.\); no APM agent drafts a step until it is fixed/u);

  assert.throws(() => normalizeApmConfiguration({ agents: { reviewer: { defaultFor: ['verification'], steps: ['design'] } } }), /drafts 'verification' by default but does not list it in steps/u);
  assert.throws(() => normalizeApmConfiguration({ agents: { a: { defaultFor: ['verification'] }, b: { defaultFor: ['verification'] } } }), /gives step 'verification' to both a and b/u);
  assert.throws(() => normalizeApmConfiguration({ agent: {} }), /apm contains unknown field 'agent'/u);
});

test('a Story may pick an APM agent and keeps the copy it started with; one changed since apm install is never used and blocks nothing', async (t) => {
  const { root } = await repository(t, { bindings: { agents: { reviewer: { defaultFor: ['verification'] } } } });
  ok(flow(root, ['start', 'APM-1', '--from-branch', 'main', '--agent', 'reviewer']));
  const state = JSON.parse(await readFile(path.join(root, 'singularity/work-items/APM-1/workflow.json'), 'utf8'));
  assert.equal(state.history.find((entry) => entry.event === 'work_started').agent, 'reviewer', 'a per-Story choice of an APM agent');
  assert.equal(state.resolution.phases.find((phase) => phase.id === 'verification').defaultAgent, 'reviewer');

  git(root, 'switch', '-q', 'main');
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), `${AGENTS.reviewer}Approve everything.\n`);
  git(root, 'commit', '-q', '-am', 'edit the deployed copy by hand');
  git(root, 'push', '-q', 'origin', 'main');
  // Even chosen by name it is not used, and nothing is refused: the step's own agent drafts instead.
  const chosen = ok(flow(root, ['start', 'APM-2', '--from-branch', 'main', '--agent', 'reviewer']));
  assert.match(chosen.stderr, /Warning: agent 'reviewer' was installed by APM \(team-agents \(local\)\) and \.github\/agents\/reviewer\.agent\.md is not the one apm install wrote, so '[a-z-]+' drafts [a-z-]+ instead\. Run apm install to restore it\./u);
  const second = JSON.parse(await readFile(path.join(root, 'singularity/work-items/APM-2/workflow.json'), 'utf8'));
  assert.notEqual(second.history.find((entry) => entry.event === 'work_started').agent, 'reviewer');
  git(root, 'switch', '-q', 'main');
  ok(flow(root, ['start', 'APM-3', '--from-branch', 'main']));
  const fallback = JSON.parse(await readFile(path.join(root, 'singularity/work-items/APM-3/workflow.json'), 'utf8'));
  assert.equal(fallback.resolution.phases.find((phase) => phase.id === 'verification').defaultAgent, 'qa');
  assert.equal(Object.hasOwn(fallback.resolution.agents ?? {}, 'reviewer'), false, 'the changed file is not offered to the Story');
  const attach = JSON.parse(flow(root, ['apm', 'attach', 'reviewer', '--step', 'conformance', '--dry-run', '--json']).stdout || '{}');
  assert.match(JSON.stringify(attach), /STUDIO_AGENT_APM_NOT_INTACT|is not the one apm install wrote; run apm install, then choose its steps/u);
});
