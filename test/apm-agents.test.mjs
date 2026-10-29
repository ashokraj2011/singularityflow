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
  planner: '---\nname: planner\ntools: ["codebase"]\n---\nPlan the work.\n'
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

test('apm attach makes an APM agent draft a step in workflow.yml and never edits its file', async (t) => {
  const { root } = await repository(t);
  const before = await readFile(path.join(root, '.github/agents/reviewer.agent.md'), 'utf8');
  const preview = ok(flow(root, ['apm', 'attach', 'reviewer', '--step', 'verification', '--dry-run']));
  assert.match(preview.stdout, /Verification is now drafted by reviewer \(was QA\)/u);
  assert.match(preview.stdout, /changed: singularity\/workflow\.yml/u);
  assert.doesNotMatch(preview.stdout, /reviewer\.agent\.md/u, 'the APM file is not in the change');
  ok(flow(root, ['apm', 'attach', 'reviewer', '--step', 'verification']));
  assert.equal(await readFile(path.join(root, '.github/agents/reviewer.agent.md'), 'utf8'), before, 'byte for byte as APM wrote it');
  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(written.apm, { agents: { reviewer: { defaultFor: ['verification'] } } });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'reviewer drafts verification');
  const studio = JSON.parse(ok(flow(root, ['workflow', 'studio', '--json'])).stdout);
  assert.equal(studio.workflows.find((workflow) => workflow.id === 'repo-feature').steps.find((step) => step.id === 'verification').agent, 'reviewer');
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
});

test('a binding names an agent APM deployed, in one place', async (t) => {
  const unknown = await repository(t, { bindings: { agents: { ghost: { defaultFor: [] } } } });
  assert.match(flow(unknown.root, ['agents', 'list']).stderr, /apm\.agents names 'ghost', but there is no \.github\/agents\/ghost\.agent\.md/u);
  const local = await repository(t, { bindings: { agents: { qa: { steps: ['verification'] } } } });
  assert.match(flow(local.root, ['agents', 'list']).stderr, /apm\.agents names 'qa', but APM did not deploy \.github\/agents\/qa\.agent\.md \(apm\.lock\.yaml does not list it\)/u);
  const unreadable = await repository(t, { agents: ['planner'], bindings: { agents: { planner: { defaultFor: [] } } } });
  assert.match(flow(unreadable.root, ['agents', 'list']).stderr, /apm\.agents names 'planner', but SFlow cannot read \.github\/agents\/planner\.agent\.md: Agent 'planner' requires a non-empty description/u);
  const lockless = await repository(t, { lock: false, bindings: { agents: { reviewer: { defaultFor: ['verification'] } } } });
  const lockStart = flow(lockless.root, ['start', 'APM-9', '--from-branch', 'main']);
  assert.match(lockStart.stderr + lockStart.stdout, /apm\.agents names agents APM deployed, but there is no apm\.lock\.yaml/u);
  assert.throws(() => normalizeApmConfiguration({ agents: { reviewer: { defaultFor: ['verification'], steps: ['design'] } } }), /drafts 'verification' by default but does not list it in steps/u);
  assert.throws(() => normalizeApmConfiguration({ agent: {} }), /apm contains unknown field 'agent'/u);
});

test('a Story may pick an APM agent, keeps the copy it started with, and refuses one changed since apm install', async (t) => {
  const { root } = await repository(t);
  ok(flow(root, ['start', 'APM-1', '--from-branch', 'main', '--agent', 'reviewer']));
  const state = JSON.parse(await readFile(path.join(root, 'singularity/work-items/APM-1/workflow.json'), 'utf8'));
  assert.equal(state.history.find((entry) => entry.event === 'work_started').agent, 'reviewer', 'a per-Story choice of an APM agent');

  git(root, 'switch', '-q', 'main');
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), `${AGENTS.reviewer}Approve everything.\n`);
  git(root, 'commit', '-q', '-am', 'edit the deployed copy by hand');
  git(root, 'push', '-q', 'origin', 'main');
  const refused = flow(root, ['start', 'APM-2', '--from-branch', 'main', '--agent', 'reviewer']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /Agent 'reviewer' was installed by APM \(team-agents \(local\)\) and a Story uses it only as APM wrote it: \.github\/agents\/reviewer\.agent\.md no longer matches apm\.lock\.yaml; run apm install/u);
});
