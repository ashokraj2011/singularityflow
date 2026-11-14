// SPEC-AGH: SFlow's step agents live in singularity/agents, a team's own .github/agents is never
// SFlow's, and the package refresh moves a legacy repository's agents as one reviewed change.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { loadDefinition, initializeDefinition } from '../src/config.mjs';
import { agentsRootOf, AGENTS_HOME, LEGACY_AGENTS_ROOT } from '../src/configuration-assets.mjs';
import { agentsHomeLines, planAgentsHomeMigration } from '../src/agents-home-migration.mjs';
import { configurationAssetPolicy, isConfigurationAssetPath } from '../src/configuration-assets.mjs';
import { applicationPathContext } from '../src/application-paths.mjs';
import { isKnownPackagedAssetHash } from '../src/packaged-asset-history.mjs';
import { refreshPackagedConfiguration, refreshWorkspaceConfigurations } from '../src/workspace-configuration-refresh.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { run } from '../src/util.mjs';
import { toLegacyAgentsLayout } from './helpers/agents-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const TEAM_DEVELOPER = '---\nname: developer\ndescription: Our team\'s own developer agent.\ntools: [\'codebase\', \'editFiles\']\n---\nAlways write Kotlin.\n';
const TEAM_REVIEWER = '---\nname: security-reviewer\ndescription: Our team\'s security reviewer.\n---\nReview every change for secrets.\n';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function flow(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1' } });
  if (result.status !== 0 && !allowFailure) throw new Error(`${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const git = (cwd, ...args) => run('git', args, { cwd }).stdout.trim();

/** Every file under `directory` with its digest, so "untouched" means byte for byte. */
async function tree(directory, relative = '') {
  const output = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true }).catch(() => [])) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(output, await tree(directory, child));
    else output[child] = sha(await readFile(path.join(directory, child)));
  }
  return output;
}

async function teamRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Agents Home Test'); git(root, 'config', 'user.email', 'agents-home@example.test');
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), TEAM_DEVELOPER);
  await writeFile(path.join(root, '.github/agents/security-reviewer.agent.md'), TEAM_REVIEWER);
  await writeFile(path.join(root, 'src/a.mjs'), 'export const x = 1;\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"t","type":"module","private":true,"scripts":{"test":"node --test"}}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'A team repository with its own agents');
  return root;
}

/** An SFlow configuration as a build before SPEC-AGH wrote it, plus the team's two own agents. */
async function legacyConfiguration(t, { team = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  await toLegacyAgentsLayout(root);
  if (team) await writeFile(path.join(root, '.github/agents/security-reviewer.agent.md'), TEAM_REVIEWER);
  return root;
}

for (const [route, args] of [['legacy init', ['init']], ['smart init', ['init', '--smart-detect', '--yes']]]) {
  test(`${route} onboards a repository with its own developer and security-reviewer agents [AGH:AC-001]`, async (t) => {
    const root = await teamRepository(t);
    const before = await tree(path.join(root, '.github/agents'));
    flow(root, args);
    assert.deepEqual(await tree(path.join(root, '.github/agents')), before, 'nothing in .github/agents changed');
    const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
    assert.equal(workflow.agentPromptsRoot, AGENTS_HOME);
    const definition = await loadDefinition(root);
    assert.equal(definition.agentPromptsRoot, AGENTS_HOME);
    assert.equal(definition.agents.developer.source, 'singularity/agents/developer.agent.md');
    assert.ok(definition.agents.developer.defaultFor.length, 'SFlow\'s developer drafts its steps');
    assert.equal(definition.agents['security-reviewer'], undefined, 'the team\'s own agent is not read');
    assert.equal(flow(root, ['init', '--check', '--json']).status, 0);
  });
}

test('the layout is what workflow.yml records, and any other value is the legacy layout it was [AGH:REQ-002, REQ-005]', () => {
  assert.equal(agentsRootOf({}), LEGACY_AGENTS_ROOT);
  assert.equal(agentsRootOf({ agentPromptsRoot: AGENTS_HOME }), AGENTS_HOME);
  assert.equal(agentsRootOf({ agentPromptsRoot: 'governed/agents' }), LEGACY_AGENTS_ROOT);
  const transport = configurationAssetPolicy({ agentPromptsRoot: 'governed/agents' });
  assert.equal(isConfigurationAssetPath('governed/agents/x.agent.md', transport), true, 'still a transport root, as at the baseline');
  assert.equal(isConfigurationAssetPath('.github/agents/x.agent.md', transport), true);
  assert.ok(applicationPathContext({ agentPromptsRoot: 'governed/agents' }).governedRoots.includes(LEGACY_AGENTS_ROOT));
  assert.equal(isConfigurationAssetPath('.github/agents/x.agent.md', configurationAssetPolicy({})), true);
  assert.equal(isConfigurationAssetPath('.github/agents/x.agent.md', configurationAssetPolicy({ agentPromptsRoot: AGENTS_HOME })), false);
  assert.equal(isConfigurationAssetPath('.github/agents/bound.agent.md',
    configurationAssetPolicy({ agentPromptsRoot: AGENTS_HOME, apm: { agents: { bound: { steps: ['implementation'] } } } })), true, 'a bound APM agent is configuration');
  assert.ok(applicationPathContext({}).governedRoots.includes(LEGACY_AGENTS_ROOT));
  assert.ok(!applicationPathContext({ agentPromptsRoot: AGENTS_HOME }).governedRoots.includes(LEGACY_AGENTS_ROOT));
  assert.equal(isKnownPackagedAssetHash('singularity/agents/developer.agent.md',
    sha(spawnSync('cat', [path.join(ROOT, 'templates/agents/developer.agent.md')]).stdout)), true, 'package history follows a moved agent');
});

test('a legacy configuration loads unchanged and its preview moves SFlow\'s agents only [AGH:AC-002, AC-003]', async (t) => {
  const root = await legacyConfiguration(t);
  const definition = await loadDefinition(root);
  assert.equal(definition.agentPromptsRoot, LEGACY_AGENTS_ROOT);
  assert.equal(definition.agents.developer.source, '.github/agents/developer.agent.md');
  assert.ok(definition.governedRoots.includes(LEGACY_AGENTS_ROOT));
  const before = await tree(root);
  const preview = await refreshPackagedConfiguration(root, { dryRun: true });
  assert.deepEqual(await tree(root), before, 'a preview writes nothing');
  const home = preview.agentsHome;
  assert.equal(home.status, 'proposed');
  assert.ok(home.moves.some((move) => move.from === '.github/agents/developer.agent.md' && move.to === 'singularity/agents/developer.agent.md'));
  assert.deepEqual(home.stays, [{ path: '.github/agents/security-reviewer.agent.md', reason: 'own' }]);
  const lines = agentsHomeLines(home).join('\n');
  assert.match(lines, /moves: \.github\/agents\/developer\.agent\.md → singularity\/agents\/developer\.agent\.md/u);
  assert.match(lines, /stays: \.github\/agents\/security-reviewer\.agent\.md \(your own agent\)/u);
});

test('the migration moves SFlow\'s agents byte for byte, sets the signal, and is a no-op again [AGH:AC-004, AC-007]', async (t) => {
  const root = await legacyConfiguration(t);
  const moved = Object.fromEntries(Object.entries(await tree(path.join(root, '.github/agents'))).filter(([name]) => name !== 'security-reviewer.agent.md'));
  const result = await refreshPackagedConfiguration(root);
  assert.equal(result.agentsHome.status, 'proposed');
  assert.deepEqual(await tree(path.join(root, AGENTS_HOME)), moved, 'every agent keeps its bytes and its name');
  assert.deepEqual(await tree(path.join(root, '.github/agents')), { 'security-reviewer.agent.md': sha(TEAM_REVIEWER) });
  const text = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.match(text, /^version: 2\n# SFlow's step agents live in singularity\/agents;.*\nagentPromptsRoot: singularity\/agents\n/u);
  const after = await loadDefinition(root);
  assert.equal(after.agents.developer.source, 'singularity/agents/developer.agent.md');
  assert.equal(after.agents['security-reviewer'], undefined);
  const again = await refreshPackagedConfiguration(root);
  assert.equal(again.agentsHome, undefined);
  assert.equal(again.changed, false, JSON.stringify(again.files));
});

test('an interrupted migration resumes and ends where an uninterrupted one does [AGH:AC-008]', async (t) => {
  const whole = await legacyConfiguration(t);
  await refreshPackagedConfiguration(whole);
  const half = await legacyConfiguration(t);
  // Half moved: one file moved, one copied with its source still there.
  await mkdir(path.join(half, AGENTS_HOME), { recursive: true });
  await rename(path.join(half, '.github/agents/qa.agent.md'), path.join(half, AGENTS_HOME, 'qa.agent.md'));
  await cp(path.join(half, '.github/agents/architect.agent.md'), path.join(half, AGENTS_HOME, 'architect.agent.md'));
  const plan = await planAgentsHomeMigration(half, YAML.parse(await readFile(path.join(half, 'singularity/workflow.yml'), 'utf8')));
  assert.equal(plan.status, 'proposed');
  assert.ok(plan.completed.some((entry) => entry.from === '.github/agents/architect.agent.md'));
  assert.ok(!plan.moves.some((entry) => entry.from === '.github/agents/qa.agent.md'));
  await refreshPackagedConfiguration(half);
  const strip = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('singularity/.product/')));
  assert.deepEqual(strip(await tree(half)), strip(await tree(whole)));
});

test('a destination with other bytes holds the move and names both files [AGH:REQ-018]', async (t) => {
  const root = await legacyConfiguration(t);
  await mkdir(path.join(root, AGENTS_HOME), { recursive: true });
  await writeFile(path.join(root, AGENTS_HOME, 'qa.agent.md'), '---\nname: qa-copy\ndescription: Someone else\'s copy.\n---\nOther bytes.\n');
  const result = await refreshPackagedConfiguration(root);
  assert.equal(result.agentsHome.status, 'held');
  assert.deepEqual(result.agentsHome.conflicts.map((entry) => [entry.from, entry.to]), [['.github/agents/qa.agent.md', 'singularity/agents/qa.agent.md']]);
  assert.equal(agentsRootOf(YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'))), LEGACY_AGENTS_ROOT);
  assert.match(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'), /sflow-default-for/u, 'nothing moved');
  assert.match(agentsHomeLines(result.agentsHome).join('\n'), /held: .*Keep one of them in sflow\/config, then preview again\./u);
});

test('a workflow.yml naming its own agentPromptsRoot holds the move, keeps that root carried, and says how to go on [AGH:REQ-005, REQ-018]', async (t) => {
  const root = await legacyConfiguration(t);
  const file = path.join(root, 'singularity/workflow.yml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/^version: 2\n/u, 'version: 2\nagentPromptsRoot: governed/agents\n'));
  await mkdir(path.join(root, 'governed/agents'), { recursive: true });
  await writeFile(path.join(root, 'governed/agents/notes.md'), 'carried as configuration\n');
  assert.equal((await loadDefinition(root)).agents.developer.source, '.github/agents/developer.agent.md');
  const before = await tree(path.join(root, '.github/agents'));
  const result = await refreshPackagedConfiguration(root);
  assert.equal(result.agentsHome.status, 'held');
  assert.equal(result.agentsHome.transportRoot, 'governed/agents');
  assert.deepEqual(await tree(path.join(root, '.github/agents')), before, 'nothing moved');
  assert.match(await readFile(file, 'utf8'), /^agentPromptsRoot: governed\/agents$/mu, 'the key is kept');
  assert.match(agentsHomeLines(result.agentsHome).join('\n'),
    /held: workflow\.yml agentPromptsRoot names governed\/agents.*remove that key in sflow\/config.*then preview again\./u);
});

test('a team file that shadows a packaged agent stays, and SFlow\'s agent is installed [AGH:AC-009]', async (t) => {
  const root = await legacyConfiguration(t);
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), TEAM_DEVELOPER);
  await assert.rejects(loadDefinition(root), /exactly one default agent/u, 'the broken case of SPEC-AGH section 2');
  const result = await refreshPackagedConfiguration(root, { resolutions: { 'singularity/agents/developer.agent.md': 'bundled' } });
  assert.ok(result.agentsHome.stays.some((entry) => entry.path === '.github/agents/developer.agent.md' && entry.reason === 'shadow'));
  assert.equal(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'), TEAM_DEVELOPER);
  assert.equal(await readFile(path.join(root, AGENTS_HOME, 'developer.agent.md'), 'utf8'),
    await readFile(path.join(ROOT, 'templates/agents/developer.agent.md'), 'utf8'));
  assert.equal((await loadDefinition(root)).agents.developer.source, 'singularity/agents/developer.agent.md');
});

test('an agent APM deployed stays in .github/agents and still drafts its bound step [AGH:REQ-011]', async (t) => {
  const root = await legacyConfiguration(t, { team: false });
  const apmAgent = '---\nname: apm-reviewer\ndescription: From a package.\n---\nReview.\n';
  await writeFile(path.join(root, '.github/agents/apm-reviewer.agent.md'), apmAgent);
  await writeFile(path.join(root, 'apm.lock.yaml'), YAML.stringify({ lockfile_version: '1', dependencies: [],
    local_deployed_files: ['.github/agents/apm-reviewer.agent.md'], local_deployed_file_hashes: { '.github/agents/apm-reviewer.agent.md': `sha256:${sha(apmAgent)}` } }));
  const result = await refreshPackagedConfiguration(root);
  assert.deepEqual(result.agentsHome.stays, [{ path: '.github/agents/apm-reviewer.agent.md', reason: 'apm' }]);
  const definition = await loadDefinition(root);
  assert.equal(definition.agents['apm-reviewer']?.source, '.github/agents/apm-reviewer.agent.md');
  assert.equal(definition.agents['apm-reviewer'].apm?.state, 'intact');
});

test('factory reset keeps the agents home and never touches the team\'s .github/agents [AGH:AC-010]', async (t) => {
  const root = await teamRepository(t);
  flow(root, ['init']);
  const custom = '---\nname: company-reviewer\ndescription: Our company reviewer for SFlow steps.\nmetadata:\n  sflow-label: "Company reviewer"\n---\nReview.\n';
  await writeFile(path.join(root, AGENTS_HOME, 'company-reviewer.agent.md'), custom);
  await writeFile(path.join(root, AGENTS_HOME, 'qa.agent.md'), 'edited packaged agent\n');
  const broken = '---\nname: company-broken\n---\nNo description.\n';
  await writeFile(path.join(root, AGENTS_HOME, 'company-broken.agent.md'), broken);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Configuration');
  const team = await tree(path.join(root, '.github/agents'));
  const plan = JSON.parse(flow(root, ['factory-reset', '--dry-run', '--json']).stdout);
  assert.equal(plan.agentsRoot, AGENTS_HOME);
  flow(root, ['factory-reset', '--confirm', plan.confirmation, '--expect-scope-sha256', plan.resetScopeSha256, '--json']);
  assert.deepEqual(await tree(path.join(root, '.github/agents')), team);
  assert.equal(await readFile(path.join(root, AGENTS_HOME, 'company-reviewer.agent.md'), 'utf8'), custom, 'a compatible custom agent is kept');
  assert.equal(await readFile(path.join(root, AGENTS_HOME, 'qa.agent.md'), 'utf8'),
    await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8'), 'a packaged agent is restored');
  assert.equal((await loadDefinition(root)).agentPromptsRoot, AGENTS_HOME);
  // An invalid custom agent leaves active discovery with its bytes kept, as on the legacy layout.
  assert.ok(plan.customAgentRecoveries.some((entry) => entry.sourcePath === 'singularity/agents/company-broken.agent.md'));
  assert.equal(await readFile(path.join(root, AGENTS_HOME, 'company-broken.agent.md'), 'utf8').catch(() => null), null);
  const recovered = await tree(path.join(root, '.github/singularity-flow-recovered-agents'));
  assert.deepEqual(Object.values(recovered), [sha(broken)]);
});

/** A workflow with one new step drafted by a new agent, in `source`'s own agents root. */
async function workflowWithOwnAgent(source, id) {
  const workflowFile = path.join(source, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(workflowFile, 'utf8'));
  const phase = `${id}-note`; const templateId = `${phase}-template`; const relative = `transfer/${phase}.md`;
  configuration.templates ??= {};
  configuration.templates[templateId] = { path: relative, label: `${phase} output` };
  configuration.phases[phase] = {
    label: phase, artifact: { path: `artifacts/${phase}/output.md`, minimumBytes: 20, maximumBytes: 4096 },
    defaultTemplate: `template:${templateId}`, inputs: ['intake'],
    approval: { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1 }, writeScope: 'artifact-only',
    generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human', 'governed-agent'], task: 'analyze' }
  };
  configuration.workTypes[`${id}-feature`] = structuredClone(configuration.workTypes.feature);
  configuration.workTypes[`${id}-feature`].label = `${id} feature`;
  configuration.workTypes[`${id}-feature`].phases.splice(configuration.workTypes[`${id}-feature`].phases.indexOf('conformance'), 0, phase);
  await mkdir(path.join(source, configuration.templatesRoot, 'transfer'), { recursive: true });
  await writeFile(path.join(source, configuration.templatesRoot, relative), `# ${phase}\n\n## Inputs\n\n## Findings\n`);
  const agentsRoot = agentsRootOf(configuration);
  await writeFile(path.join(source, agentsRoot, `${id}-author.agent.md`), `---\n${YAML.stringify({ name: `${id}-author`, description: `Drafts ${phase}`,
    metadata: { 'sflow-phases': phase, 'sflow-default-for': phase } })}---\nDraft only the selected artifact.\n`);
  await writeFile(workflowFile, YAML.stringify(configuration));
  await loadDefinition(source);
  return `${id}-feature`;
}

test('a workflow moves between a migrated and an unmigrated repository both ways [AGH:AC-011]', async (t) => {
  const { applyWorkflowImport, exportWorkflowBundle, planWorkflowImport } = await import('../src/workflow-transfer.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await initializeDefinition(home);
  const legacy = await legacyConfiguration(t, { team: false });
  for (const [source, target, id] of [[home, legacy, 'homeward'], [legacy, home, 'legacyward']]) {
    const workflow = await workflowWithOwnAgent(source, id);
    const bundle = await exportWorkflowBundle(source, [workflow]);
    const carried = bundle.assets.find((asset) => asset.kind === 'agent' && asset.id === `${id}-author`);
    assert.equal(carried.path, `.github/agents/${id}-author.agent.md`, 'a bundle keeps its portable agent path');
    const plan = await planWorkflowImport(target, bundle);
    assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
    await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
    const definition = await loadDefinition(target);
    assert.equal(definition.agents[`${id}-author`].source, `${definition.agentPromptsRoot}/${id}-author.agent.md`,
      `the agent lands in ${definition.agentPromptsRoot}`);
  }
});

// ---------------------------------------------------------------- the upgrade path itself

async function legacyRemote(t, id) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agh-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, `${id}.git`);
  const application = path.join(root, 'workspace', 'repos', id);
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '--initial-branch=main', application]);
  for (const repository of [application]) {
    git(repository, 'config', 'user.name', 'Agents Home Test'); git(repository, 'config', 'user.email', 'agents-home@example.test');
  }
  await writeFile(path.join(application, 'application.txt'), 'application source\n');
  git(application, 'add', '-A'); git(application, 'commit', '-qm', 'Application'); git(application, 'remote', 'add', 'origin', remote); git(application, 'push', '-q', '-u', 'origin', 'main');
  const publisher = path.join(root, 'publisher');
  run('git', ['init', '--initial-branch=sflow/config', publisher]);
  git(publisher, 'config', 'user.name', 'Agents Home Test'); git(publisher, 'config', 'user.email', 'agents-home@example.test');
  await initializeDefinition(publisher);
  await toLegacyAgentsLayout(publisher);
  await writeFile(path.join(publisher, '.github/agents/security-reviewer.agent.md'), TEAM_REVIEWER);
  git(publisher, 'add', '-A'); git(publisher, 'commit', '-qm', 'A legacy approved configuration');
  git(publisher, 'remote', 'add', 'origin', remote); git(publisher, 'push', '-q', 'origin', 'HEAD:sflow/config');
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = { version: 1, id: `${id}-workspace`, name: `${id} workspace`, path: workspaceRoot,
    anchor: { provider: 'workspace', key: `${id}-workspace`, title: `${id} workspace` }, leadRepository: id,
    repositories: { [id]: { id, url: remote, defaultBranch: 'main', required: true, path: `repos/${id}`, role: 'lead', capabilities: [] } } };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);
  return { remote, registry };
}
const approved = (remote, relative) => run('git', ['--git-dir', remote, 'show', `sflow/config:${relative}`], { allowFailure: true });

test('an unconfirmed refresh opens the move as a review and never pushes sflow/config [AGH:AC-012]', async (t) => {
  const { remote, registry } = await legacyRemote(t, 'unconfirmed');
  const before = git(remote, 'rev-parse', 'sflow/config');
  const result = await refreshWorkspaceConfigurations({ registryFile: registry });
  const [item] = result.results;
  assert.equal(item.status, 'review-required', JSON.stringify(item, null, 2));
  assert.match(item.proposalBranch, /^sflow\/config-refresh\//u);
  assert.ok(item.agentsHome.moves.length);
  assert.equal(git(remote, 'rev-parse', 'sflow/config'), before, 'nothing moves until the review is merged');
  const proposed = run('git', ['--git-dir', remote, 'show', `${item.proposalBranch}:singularity/workflow.yml`]).stdout;
  assert.equal(YAML.parse(proposed).agentPromptsRoot, AGENTS_HOME);
  // Merged by whoever may merge into sflow/config, then the rerun finds it current.
  run('git', ['--git-dir', remote, 'update-ref', 'refs/heads/sflow/config', item.candidateCommit]);
  const rerun = await refreshWorkspaceConfigurations({ registryFile: registry });
  assert.ok(rerun.results.every((entry) => entry.agentsHome == null), JSON.stringify(rerun, null, 2));
  assert.notEqual(rerun.status, 'blocked');
});

test('a confirmed preview listing the move publishes it, and a stale one is refused [AGH:REQ-015, REQ-016]', async (t) => {
  const { remote, registry } = await legacyRemote(t, 'confirmed');
  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.ok(preview.results[0].agentsHome.moves.some((move) => move.to === 'singularity/agents/developer.agent.md'));
  assert.equal(approved(remote, 'singularity/agents/developer.agent.md').status, 128, 'a preview writes nothing');
  const applied = await refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(YAML.parse(approved(remote, 'singularity/workflow.yml').stdout).agentPromptsRoot, AGENTS_HOME);
  assert.equal(approved(remote, 'singularity/agents/developer.agent.md').stdout,
    await readFile(path.join(ROOT, 'templates/agents/developer.agent.md'), 'utf8'));
  assert.equal(approved(remote, '.github/agents/security-reviewer.agent.md').stdout, TEAM_REVIEWER, 'the team\'s own agent stays');
  const stale = await refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId });
  assert.notEqual(stale.status, 'complete', 'the old confirmation no longer matches');
});

// ---------------------------------------------------------------- a Story walked across the migration

/** What a Story's state says at a point, without the times and commits two runs never share. */
function storyState(workflow) {
  return {
    status: workflow.status ?? null, currentPhase: workflow.currentPhase ?? null,
    agentPromptsRoot: workflow.resolution?.agentPromptsRoot ?? null,
    governsLegacyAgents: (workflow.resolution?.governedRoots ?? []).includes(LEGACY_AGENTS_ROOT),
    phases: Object.fromEntries(Object.entries(workflow.phases).map(([id, phase]) => [id, {
      status: phase.status, generation: phase.generation, defaultAgent: phase.defaultAgent ?? null,
      approvals: (phase.approvals ?? []).length
    }]))
  };
}

/** A spec-driven Story started on the legacy layout, its specification approved. */
async function legacyStory(t, WORK) {
  const { approvedSpecificationStory } = await import('./helpers/submitted-planning-story.mjs');
  return approvedSpecificationStory(t, WORK, {
    configure: (configuration) => {
      configuration.workTypes['spec-driven-standard'].spec = { ...(configuration.workTypes['spec-driven-standard'].spec ?? {}), coverage: 'record' };
      delete configuration.agentPromptsRoot;
    },
    beforeStart: async ({ root, git }) => {
      await toLegacyAgentsLayout(root);
      git('add', '-A'); git('commit', '-qm', 'The configuration as an earlier build left it'); git('push', '-q', 'origin', 'main');
    }
  });
}

/** The approved configuration on main moves to the agents home, as a merged migration review leaves it. */
async function migrateMain(story) {
  const worktree = path.join(story.directory, 'main-checkout');
  story.git('worktree', 'add', '-q', worktree, 'main');
  const result = await refreshPackagedConfiguration(worktree);
  assert.equal(result.agentsHome.status, 'proposed');
  git(worktree, 'add', '-A'); git(worktree, 'commit', '-qm', '[configuration] Move SFlow\'s agents to singularity/agents');
  git(worktree, 'push', '-q', 'origin', 'main');
  return worktree;
}

test('a Story started before the migration continues after it exactly as on a repository never migrated [AGH:AC-005, AC-006]', { timeout: 600_000, skip: process.env.SINGULARITY_FLOW_TEST_SLOW === '1' ? false : 'slow lane (30 s or more): npm run test:slow, or SINGULARITY_FLOW_TEST_SLOW=1' }, async (t) => {
  const { implementationPlan } = await import('./helpers/submitted-planning-story.mjs');
  const WORK = 'AGH-1';
  const [migrated, unmigrated] = [await legacyStory(t, WORK), await legacyStory(t, WORK)];
  const state = async (story) => storyState(JSON.parse(await readFile(path.join(story.item, 'workflow.json'), 'utf8')));
  const both = async (step) => { for (const story of [migrated, unmigrated]) await step(story); };
  const compare = async (point) => {
    const [left, right] = [await state(migrated), await state(unmigrated)];
    assert.deepEqual(left, right, `${point}: the migrated repository's Story is where the other one is`);
    return left;
  };

  const started = await compare('specification approved');
  assert.equal(started.agentPromptsRoot, LEGACY_AGENTS_ROOT);
  assert.equal(started.governsLegacyAgents, true);

  const main = await migrateMain(migrated);
  assert.equal((await loadDefinition(main)).agentPromptsRoot, AGENTS_HOME, 'main now has its agents in singularity/agents');
  assert.ok((await readdir(path.join(migrated.root, LEGACY_AGENTS_ROOT))).includes('developer.agent.md'), 'the Story keeps its own agents');
  await compare('after the migration');

  // Each step after the migration, the same on both.
  await both((story) => story.cli('session', 'current', '--for-agent', '--json'));
  await both((story) => story.cli('prepare', 'planning'));
  const planner = await compare('planning prepared');
  assert.equal(planner.phases.planning.status, 'in_progress');
  await both(async (story) => {
    await writeFile(path.join(story.item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
    story.cli('artifact', 'scan', '--phase', 'planning');
    story.cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  });
  await compare('planning published');
  const prompt = (story) => readdir(path.join(story.item, 'context')).then(async (names) => {
    const agents = names.filter((name) => /^agents-planning-gen\d+\.json$/u.test(name)).sort();
    return agents.length ? JSON.parse(await readFile(path.join(story.item, 'context', agents.at(-1)), 'utf8')) : null;
  });
  assert.deepEqual(await prompt(migrated), await prompt(unmigrated), 'the step composed with the same agent record');
  await both((story) => story.cli('submit', 'planning', '--skip-checks'));
  await both((story) => story.cli('approve', 'planning', '--yes'));
  const planned = await compare('planning approved');
  assert.equal(planned.phases.planning.status, 'approved');
  assert.equal(planned.agentPromptsRoot, LEGACY_AGENTS_ROOT, 'the Story kept the layout it started with');

  // A new Story on the migrated repository reads its agents from singularity/agents.
  const startedAfter = spawnSync(process.execPath, [CLI, '--no-model', 'start', 'AGH-2', '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'A Story after the move', '--description', 'Return an approved value.'], { cwd: main, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', SINGULARITY_FLOW_NO_MODEL: '1' } });
  assert.equal(startedAfter.status, 0, `${startedAfter.stdout}\n${startedAfter.stderr}`);
  const second = JSON.parse(await readFile(path.join(main, 'singularity/work-items/AGH-2/workflow.json'), 'utf8'));
  assert.equal(second.resolution.agentPromptsRoot, AGENTS_HOME, 'a Story started after the move pins the agents home');
  assert.equal((second.resolution.governedRoots ?? []).includes(LEGACY_AGENTS_ROOT), false);
  assert.ok((await readdir(path.join(main, AGENTS_HOME))).includes('developer.agent.md'));
});

test('every state of the move names its next step on the shell, and none is a dead end [AGH:AC-013, REQ-019]', async (t) => {
  const { remote, registry } = await legacyRemote(t, 'routes');
  const shell = (args) => {
    const result = spawnSync(process.execPath, [CLI, '--no-model', 'workspace', 'refresh-configuration', ...args], { cwd: path.dirname(registry), encoding: 'utf8',
      env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry } });
    return { status: result.status, text: `${result.stdout}\n${result.stderr}` };
  };
  // Legacy, previewed: the moves, the stays, and the route that confirms them.
  const preview = shell(['--dry-run']);
  assert.equal(preview.status, 0, preview.text);
  assert.match(preview.text, /Agents move to singularity\/agents: \d+ file\(s\)/u);
  assert.match(preview.text, /stays: \.github\/agents\/security-reviewer\.agent\.md \(your own agent\)/u);
  assert.match(preview.text, /Stories already running keep their own agents/u);
  assert.match(preview.text, /Apply this plan:\n- Copilot: \/sf-confirm [A-Z0-9]{4}-[A-Z0-9]{4}\n- Shell: singularity-flow confirm [A-Z0-9]{4}-[A-Z0-9]{4}/u,
    'the preview names the route that confirms it');
  // Unconfirmed: a review, and what to do with it.
  const unconfirmed = shell([]);
  assert.match(unconfirmed.text, /Review branch: sflow\/config-refresh\//u);
  assert.match(unconfirmed.text, /Merge each review branch into sflow\/config to approve its agents move, then re-run this command/u);
  // Merged, then current: the rerun completes and there is nothing left to move.
  const proposal = run('git', ['--git-dir', remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/sflow/config-refresh/']).stdout.trim().split('\n')[0];
  run('git', ['--git-dir', remote, 'update-ref', 'refs/heads/sflow/config', proposal]);
  const current = shell([]);
  assert.doesNotMatch(current.text, /Agents move to/u);
  assert.equal(current.status, 0, current.text);
});
