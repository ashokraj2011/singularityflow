/**
 * The registered World Model (WMB v4), the CALM architecture projection and architecture intent are
 * removed. Phase prompts keep the Repository brief read from the source. An old configuration still
 * loads (its removed settings are dropped and doctor names them), removed commands refuse by name
 * with a pointer to the brief, and a repository seeded from the earlier package still upgrades.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { removedSettings } from '../src/removed-features.mjs';
import { isKnownPackagedWorkflowValue } from '../src/packaged-workflow-history.mjs';
import { KNOWN_PACKAGED_ASSET_SHA256 } from '../src/packaged-asset-history.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initialized(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-removed-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'World Model Removed');
  git(repository, 'config', 'user.email', 'wm-removed@example.invalid');
  await writeFile(path.join(repository, 'app.mjs'), 'export const value = 1;\n');
  await initializeDefinition(repository);
  git(repository, 'add', '-A');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initialize');
  return repository;
}

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [bin, '--no-model', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
}

test('the packaged configuration carries no removed setting, so a fresh repository has nothing to clean up', async (t) => {
  const template = YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8'));
  assert.deepEqual(Object.keys(template.worldModel).sort(), ['knowledge']);
  assert.equal(Object.hasOwn(template, 'architectureIntent'), false);
  for (const [id, phase] of Object.entries(template.phases)) assert.equal(Object.hasOwn(phase, 'worldModel'), false, id);
  for (const [id, workType] of Object.entries(template.workTypes)) {
    for (const [phaseId, override] of Object.entries(workType.phaseOverrides ?? {})) {
      assert.equal(Object.hasOwn(override ?? {}, 'worldModel'), false, `${id}.${phaseId}`);
    }
  }
  const repository = await initialized(t);
  assert.deepEqual(removedSettings(await loadDefinition(repository)), []);
  const doctor = cli(repository, 'doctor', '--json');
  assert.doesNotMatch(`${doctor.stdout}${doctor.stderr}`, /removed-settings/u);
});

test('an old configuration still loads: removed settings are dropped and doctor names them', async (t) => {
  const repository = await initialized(t);
  const file = path.join(repository, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(file, 'utf8'));
  workflow.worldModel = {
    ...workflow.worldModel, sourceRoots: ['src'], registered: 'on', format: 'registered-v4',
    views: ['dev.impact@4'], grounding: 'enforce', staleness: 'fail', outputDir: 'singularity/world-model'
  };
  workflow.architectureIntent = { enabled: true, allowedPhases: ['design'] };
  workflow.phases.intake.worldModel = { views: ['biz.rules'], depth: 'quick' };
  await writeFile(file, YAML.stringify(workflow));
  const definition = await loadDefinition(repository);
  assert.deepEqual(Object.keys(definition.worldModel).sort(), ['knowledge', 'sourceRoots']);
  assert.deepEqual(definition.worldModel.sourceRoots, ['src'], 'the source scope is kept');
  assert.equal(Object.hasOwn(definition, 'architectureIntent'), false);
  assert.equal(Object.hasOwn(definition.phases.intake, 'worldModel'), false);
  const removed = removedSettings(definition);
  for (const name of ['architectureIntent', 'worldModel.registered', 'worldModel.views', 'worldModel.grounding']) {
    assert.ok(removed.includes(name), name);
  }
  assert.ok(removed.some((name) => /World Model views on 1 phase/u.test(name)));
  const doctor = cli(repository, 'doctor', '--json');
  assert.match(`${doctor.stdout}${doctor.stderr}`, /removed-settings/u);
});

test('removed commands refuse by name and point to the Repository brief', async (t) => {
  const repository = await initialized(t);
  for (const args of [['wm', 'build'], ['wm', 'status', '--json'], ['wm', 'migrate-views', '--dry-run'], ['wm', 'doctor']]) {
    const result = cli(repository, ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /registered World Model was removed/u, args.join(' '));
    assert.match(output, /singularity-flow wm brief --phase PHASE/u, args.join(' '));
  }
  const architecture = cli(repository, 'architecture', 'explain');
  assert.notEqual(architecture.status, 0);
  assert.match(`${architecture.stdout}${architecture.stderr}`, /'architecture' was removed/u);
  const capability = cli(repository, 'capability', 'world-model', 'payments', '--lead', 'https://example.invalid/lead.git');
  assert.notEqual(capability.status, 0);
  assert.match(`${capability.stdout}${capability.stderr}`, /capability world-model no longer exists/u);
  const bootstrap = cli(repository, 'bootstrap', 'https://example.invalid/app.git', '--capability', 'payments', '--grounding', 'warn');
  assert.notEqual(bootstrap.status, 0);
  assert.match(`${bootstrap.stdout}${bootstrap.stderr}`, /bootstrap --grounding no longer exists/u);
});

test('a repository seeded from the earlier package keeps its packaged phases and agents framework-owned', async () => {
  const template = YAML.parse(await readFile(path.join(root, 'templates', 'workflow.yml'), 'utf8'));
  // The earlier package shipped the same Intake phase with its World Model views.
  const earlierIntake = { ...template.phases.intake, worldModel: { views: ['biz.rules'], depth: 'quick' } };
  assert.equal(isKnownPackagedWorkflowValue('phases', 'intake', earlierIntake), true);
  assert.equal(isKnownPackagedWorkflowValue('phases', 'intake', template.phases.intake), true);
  // …and the same developer agent with its views header.
  const agent = await readFile(path.join(root, 'templates', 'agents', 'developer.agent.md'), 'utf8');
  assert.doesNotMatch(agent, /sflow-world-model-views/u);
  const earlierAgent = agent.replace(/^( {2}sflow-default-for: .*\n)/mu, '$1  sflow-world-model-views: "arch.contracts,dev.impact"\n');
  assert.notEqual(earlierAgent, agent);
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  const known = KNOWN_PACKAGED_ASSET_SHA256['.github/agents/developer.agent.md'];
  assert.ok(known.includes(digest(earlierAgent)), 'the earlier agent revision is registered');
  assert.ok(known.includes(digest(agent)), 'the current agent revision is registered');
});

test('VS Code: the World Model tab shows the Repository brief and edits only the source scope', async () => {
  const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
  const { configurationCenterView, updateWorldModelYaml } = await import(source('configuration-center-model.ts'));
  const { configurationCenterHtml } = await import(source('configuration-center-page.ts'));
  const snapshot = {
    identities: { git: { name: 'Casey Dev', email: 'casey@example.com', login: 'caseydev' }, github: 'caseydev' },
    configurationSource: { editor: 'effective', effective: null, candidate: null },
    definition: { worldModel: { sourceRoots: ['apps/payments'], sharedRoots: [] } }
  };
  const view = configurationCenterView(snapshot, { name: 'Casey', role: 'architect' });
  assert.deepEqual(view.worldModel, { sourceRoots: ['apps/payments'], sharedRoots: [] });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /Repository brief/u);
  assert.match(html, /data-action="repository-brief"/u);
  assert.match(html, /name="sourceRoots"[^>]*value="apps\/payments"/u);
  assert.doesNotMatch(html, /build-world-model|rebuild-world-model|CALM|Declared views/u);
  const yaml = 'worldModel:\n  knowledge:\n    prompt: slice\n  grounding: warn\n';
  const updated = updateWorldModelYaml(yaml, { sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts'] });
  assert.deepEqual(YAML.parse(updated).worldModel, {
    knowledge: { prompt: 'slice' }, grounding: 'warn', sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts']
  }, 'only the source scope is written; nothing else in the file is touched');
  assert.throws(() => updateWorldModelYaml(yaml, { sourceRoots: ['../outside'], sharedRoots: [] }), /repository-relative directory/u);
});
