/**
 * SPEC-AGH on every workflow-authoring surface [owner, 2026-11-15]: Workflow Studio (its model and a
 * new agent), the builder's simplify, `workflow check`, `validate` and `fix` name each agent where the
 * repository keeps it, on the agents home and on a repository whose agents have not moved. After the
 * upgrade moves them, none of them names .github/agents. The ratchet at the end keeps every source
 * file reading an agent's location through the one resolver (src/configuration-assets.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { repositoryOwnedWorkflows, requirementsTemplatePlansCode } from './helpers/repository-owned-workflows.mjs';
import { addFamilyWorkflow } from './helpers/custom-workflow-fixture.mjs';
import { toLegacyAgentsLayout } from './helpers/agents-layout.mjs';
import { AGENTS_HOME, LEGACY_AGENTS_ROOT } from '../src/configuration-assets.mjs';
import { refreshPackagedConfiguration } from '../src/workspace-configuration-refresh.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-surfaces-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Surface Tester',
    SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(state, 'outbox') };
  const run = (command, args, cwd, { input = '', allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);
  const json = (cwd, args, options) => {
    const result = flow(cwd, [...args, '--json'], options);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`${args.join(' ')} printed no JSON\n${result.stdout}\n${result.stderr}`); }
  };
  return { state, run, flow, json };
}

/** The family workflow of test/helpers/custom-workflow-fixture.mjs, with a broken link in an agent file. */
async function familyRepository(h, { legacy }) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-surfaces-repo-'));
  const root = path.join(base, 'app');
  h.run('git', ['init', '-q', '-b', 'main', root], base);
  h.run('git', ['config', 'user.name', 'Surface Tester'], root); h.run('git', ['config', 'user.email', 'surface@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Family\n');
  h.flow(root, ['init']);
  if (legacy) await toLegacyAgentsLayout(root);
  await repositoryOwnedWorkflows(root);
  await requirementsTemplatePlansCode(root);
  await addFamilyWorkflow(root);
  await appendFile(path.join(root, legacy ? LEGACY_AGENTS_ROOT : AGENTS_HOME, 'fmly-engineer.agent.md'), '\nFollow [the runbook](runbook.md).\n');
  h.run('git', ['add', '-A'], root); h.run('git', ['commit', '-qm', 'family workflow'], root);
  return root;
}

/** What each authoring surface says about the repository's agents, as JSON. */
async function surfaces(h, root) {
  const studio = h.json(root, ['workflow', 'studio']);
  const changeSet = path.join(root, '..', 'new-agent.json');
  await writeFile(changeSet, JSON.stringify({ schema: 'sflow-studio-change-set@1', base: studio.base, changes: [
    { op: 'agent.create', id: 'fmly-scout', label: 'Family scout', description: 'Looks ahead for the family team.', role: 'analyst' }] }));
  const created = h.json(root, ['workflow', 'studio', 'apply', '--change-set', changeSet, '--dry-run']);
  const check = h.json(root, ['workflow', 'check', 'fmly'], { allowFailure: true });
  const validate = h.json(root, ['workflow', 'validate', 'fmly'], { allowFailure: true });
  const fix = h.json(root, ['workflow', 'fix', 'fmly'], { allowFailure: true });
  const build = h.json(root, ['workflow', 'build', 'start', '--simplify', 'fmly']).build;
  return { studio, created, check, validate, fix, build };
}

function assertNamedIn(agentsRoot, { studio, created, check, validate, fix, build }) {
  const own = studio.agents.filter((agent) => agent.scope === 'repository');
  assert.ok(own.some((agent) => agent.id === 'fmly-legacy'), 'the Studio lists the repository\'s agents');
  for (const agent of own) assert.ok(String(agent.path).startsWith(`${agentsRoot}/`), `Studio: ${agent.id} at ${agent.path}`);
  assert.deepEqual(created.files.filter((file) => file.path.endsWith('.agent.md')).map((file) => [file.path, file.action]),
    [[`${agentsRoot}/fmly-scout.agent.md`, 'create']], 'Studio writes a new agent where the repository keeps its agents');
  const unused = check.repository.findings.find((entry) => entry.code === 'CHECK_AGENT_UNUSED' && entry.subject?.agent === 'fmly-legacy');
  assert.deepEqual(unused?.location, { file: `${agentsRoot}/fmly-legacy.agent.md`, line: 1 }, JSON.stringify(check.repository.findings));
  const link = check.repository.findings.find((entry) => entry.code === 'CHECK_LINK_BROKEN');
  assert.equal(link?.location?.file, `${agentsRoot}/fmly-engineer.agent.md`, 'the guidance scan reads the agent where it is');
  assert.ok(validate.repository.findings.some((entry) => entry.code === 'CHECK_AGENT_UNUSED' && entry.location?.file === `${agentsRoot}/fmly-legacy.agent.md`),
    JSON.stringify(validate.repository.findings));
  assert.ok(JSON.stringify(fix).includes(`${agentsRoot}/fmly-legacy.agent.md`), 'workflow fix names the agent file it removes');
  const [candidate] = build.simplify.candidates.filter((entry) => entry.kind === 'unused-asset');
  assert.deepEqual(candidate?.location, { file: `${agentsRoot}/fmly-legacy.agent.md`, line: 1 }, 'the builder locates the agent where it is');
}

for (const [layout, legacy, agentsRoot] of [['the agents home', false, AGENTS_HOME], ['a repository whose agents have not moved', true, LEGACY_AGENTS_ROOT]]) {
  test(`on ${layout}, Workflow Studio, the builder, check, validate and fix name each agent in ${agentsRoot}`, async () => {
    const h = await harness();
    const root = await familyRepository(h, { legacy });
    const seen = await surfaces(h, root);
    assertNamedIn(agentsRoot, seen);
    if (!legacy) assert.doesNotMatch(JSON.stringify(seen), /\.github\/agents/u, 'nothing on the agents home names .github/agents');
  });
}

test('after the upgrade moves a repository\'s agents, no authoring surface names .github/agents', async () => {
  const h = await harness();
  const root = await familyRepository(h, { legacy: true });
  const moved = await refreshPackagedConfiguration(root);
  assert.equal(moved.agentsHome?.status, 'proposed', JSON.stringify(moved.agentsHome));
  assert.deepEqual(await readdir(path.join(root, LEGACY_AGENTS_ROOT)).catch(() => []), [], 'every agent of this repository was SFlow\'s');
  h.run('git', ['add', '-A'], root); h.run('git', ['commit', '-qm', 'agents home'], root);
  const seen = await surfaces(h, root);
  assertNamedIn(AGENTS_HOME, seen);
  assert.doesNotMatch(JSON.stringify(seen), /\.github\/agents/u);
});

// ---------------------------------------------------------------------------------------------
// The ratchet: an agent's location is read through src/configuration-assets.mjs, never spelled out.

/** Files that may spell the legacy root, each with why. Anything else uses LEGACY_AGENTS_ROOT. */
const MAY_NAME_THE_LEGACY_ROOT = Object.freeze({
  'src/configuration-assets.mjs': 'the one resolver: it declares the root',
  'src/agents-home-migration.mjs': 'the migration that moves agents out of it',
  'src/packaged-asset-history.mjs': 'released package bytes, keyed by the paths those releases wrote'
});
const LEGACY_SPELLINGS = [/\.github\/agents/u, /\\\.github\\\/agents/u, /['"]\.github['"]\s*,\s*['"]agents['"]/u];
/** A line that is only a comment explains a layout; it does not decide one. */
const isComment = (line) => /^\s*(?:\/\/|\*|\/\*)/u.test(line);

async function sourceFiles(directory, extensions) {
  const out = [];
  for (const entry of await readdir(path.join(packageRoot, directory), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !extensions.some((extension) => entry.name.endsWith(extension)) || entry.name.endsWith('.d.ts')) continue;
    out.push(path.relative(packageRoot, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'));
  }
  return out.sort();
}

test('no source names .github/agents outside the resolver and the migration [AGH ratchet]', async () => {
  const files = [...await sourceFiles('src', ['.mjs']), ...await sourceFiles('apps/vscode/src', ['.ts'])];
  assert.ok(files.length > 500, `the scan found the sources (${files.length})`);
  const found = [];
  for (const file of files) {
    if (Object.hasOwn(MAY_NAME_THE_LEGACY_ROOT, file)) continue;
    const lines = (await readFile(path.join(packageRoot, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (!isComment(line) && LEGACY_SPELLINGS.some((pattern) => pattern.test(line))) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(found, [], 'use LEGACY_AGENTS_ROOT, agentsRootOf or agentFileIn from src/configuration-assets.mjs');
  for (const file of Object.keys(MAY_NAME_THE_LEGACY_ROOT)) assert.ok(files.includes(file), `${file} still exists`);
});

test('the skills an agent reads name agents only through the agents home [AGH ratchet]', async () => {
  const skills = await sourceFiles('plugin/skills', ['.md']);
  assert.ok(skills.length > 50, `the scan found the skills (${skills.length})`);
  const found = [];
  for (const file of skills) {
    (await readFile(path.join(packageRoot, file), 'utf8')).split('\n').forEach((line, index) => {
      if (/\.github\/agents\//u.test(line)) found.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
