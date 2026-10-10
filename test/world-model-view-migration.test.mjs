/**
 * A configuration that still names the retired legacy-v3 World Model keeps working (the World
 * Model is guidance: its retired entries are dropped and `doctor` names them), and
 * `wm migrate-views` rewrites them to registered views, keeping each file's formatting.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';
import { loadPortfolio } from '../src/initiative-config.mjs';
import { retiredWorldModelReferences } from '../src/world-model-views.mjs';
import { planWorldModelViewMigration, worldModelViewMigrationCommand } from '../src/world-model-view-migration.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

/** An initialized repository rewritten the way a pre-cutover configuration named its views. */
async function legacyRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-view-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Migration Tester');
  git(root, 'config', 'user.email', 'migration@example.com');
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = (await readFile(workflowPath, 'utf8'))
    .replace('  registered: off\n', '  registered: on\n')
    .replace('  views: [arch.contracts@4, biz.rules@4, dev.hotspots@4, dev.impact@4]',
      '  # every view, as v3 configurations listed them\n  views: [business, architecture, development, testing, release, operations, security]')
    .replace('    worldModel: {views: [biz.rules], depth: quick}\n    clarification:\n      mode: required',
      '    worldModel: {views: [business], depth: quick}\n    clarification:\n      mode: required')
    .replace('    worldModel: {views: [dev.impact], depth: standard}\n    clarification: { mode: when-needed, maxQuestions: 3, topics: [approved deviations, implementation blockers] }',
      '    worldModel: {views: [development, testing, release], depth: standard}\n    clarification: { mode: when-needed, maxQuestions: 3, topics: [approved deviations, implementation blockers] }');
  await writeFile(workflowPath, workflow);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = await readFile(portfolioPath, 'utf8');
  await writeFile(portfolioPath, portfolio.replace(
    /(  epic-intake:\n(?:    .*\n)*?    worldModelViews: )\[\]/u, '$1[business, operations]'));
  const agentPath = path.join(root, '.github/agents/architect.agent.md');
  const agent = await readFile(agentPath, 'utf8');
  await writeFile(agentPath, agent.replace(/sflow-world-model-views: "[^"]*"/u, 'sflow-world-model-views: "architecture,security,operations"'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Configuration written before the legacy-v3 views were retired');
  return root;
}

test('a configuration that names retired legacy-v3 views loads, runs without them, and doctor says how to migrate', async (t) => {
  const root = await legacyRepository(t);
  const definition = await loadDefinition(root);
  assert.equal(definition.worldModel.views, undefined, 'a catalog of retired names only means the registered defaults');
  assert.deepEqual(definition.phases.intake.worldModel.views, []);
  assert.deepEqual(definition.phases.implementation.worldModel.views, []);
  assert.deepEqual(definition.agents.architect.worldModelViews, []);
  const dropped = retiredWorldModelReferences(definition);
  assert.ok(dropped.some((entry) => entry.source === "phase 'implementation'" && entry.value === 'testing'));
  assert.ok(dropped.some((entry) => entry.source === "agent 'architect' prompt" && entry.value === 'security'));
  assert.deepEqual((await loadPortfolio(root)).initiativePhases['epic-intake'].worldModelViews, []);

  const doctor = await doctorSnapshot(root, { offline: true, probeModelProvider: false });
  const warning = doctor.checks.find((entry) => entry.id === 'world-model-views');
  assert.equal(warning?.status, 'warn');
  assert.match(warning.message, /retired legacy-v3 World Model reference/);
  assert.equal(doctor.checks.find((entry) => entry.id === 'configuration')?.status, 'pass');
});

test('wm migrate-views previews, requires its exact confirmation, rewrites in place and is then current', async (t) => {
  const root = await legacyRepository(t);
  const before = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  const preview = await quiet(() => worldModelViewMigrationCommand(root, { 'dry-run': true, json: true }));
  assert.equal(preview.status, 'planned');
  assert.deepEqual(preview.files.map((file) => file.path),
    ['singularity/workflow.yml', 'singularity/portfolio.yml', '.github/agents/architect.agent.md']);
  const implementation = preview.files[0].changes.filter((change) => change.location === "phase 'implementation'");
  assert.deepEqual(implementation.map((change) => `${change.from}->${change.to}`), ['development->dev.impact', 'testing->dev.impact', 'release->null']);
  assert.equal(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), before, 'a preview writes nothing');

  await assert.rejects(worldModelViewMigrationCommand(root, { confirm: 'MIGRATE WORLD MODEL VIEWS 000000000000' }),
    { code: 'WM_MIGRATE_VIEWS_CONFIRMATION_REQUIRED' });
  const applied = await quiet(() => worldModelViewMigrationCommand(root, { confirm: preview.confirmation, json: true }));
  assert.equal(applied.status, 'migrated');
  assert.match(applied.next, /config publish/);

  const after = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.match(after, /# every view, as v3 configurations listed them\n {2}views: \[arch\.contracts@4, biz\.rules@4, dev\.hotspots@4, dev\.impact@4\]/,
    'the line keeps its comment and flow style');
  assert.match(after, /worldModel: \{views: \[dev\.impact\], depth: standard\}/);
  assert.match(await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8'), /sflow-world-model-views: "arch\.contracts"/);
  const definition = await loadDefinition(root);
  assert.deepEqual(retiredWorldModelReferences(definition), []);
  assert.deepEqual(definition.phases.intake.worldModel.views, ['biz.rules']);
  assert.deepEqual((await loadPortfolio(root)).initiativePhases['epic-intake'].worldModelViews, ['biz.rules']);
  assert.equal((await planWorldModelViewMigration(root)).files.length, 0);
  assert.equal((await quiet(() => worldModelViewMigrationCommand(root, { json: true }))).status, 'current');
});
