import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  deleteDesktopFile,
  deleteDesktopTemplate,
  desktopExportBundle,
  desktopSnapshot,
  publishDesktopConfiguration,
  readDesktopFile,
  saveDesktopFile,
  selectDesktopPersona,
  validateDesktopConfiguration
} from '../src/desktop.mjs';
import { migrateLegacyConfig } from '../src/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Desktop Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' })
  };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Desktop Tester'], root);
  run('git', ['config', 'user.email', 'desktop@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Desktop test\n');
  run(process.execPath, [bin, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Desktop Tester', email: 'desktop@example.com' }];
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('desktop snapshot exposes configuration and visual workflow data', async () => {
  const root = await repository();
  let snapshot = await desktopSnapshot(root);
  assert.equal(snapshot.repository.branch, 'main');
  assert.equal(snapshot.repository.controlRoot, 'singularity');
  assert.deepEqual(snapshot.repository.configurationChanges, []);
  assert.deepEqual(snapshot.repository.unrelatedChanges, []);
  assert.equal(snapshot.repository.publishReady, false);
  assert.equal(snapshot.portfolioPath, 'singularity/portfolio.yml');
  assert.equal(snapshot.portfolio.initiativeProfiles['initiative-lite'].phases.length, 4);
  assert.equal(snapshot.portfolio.initiativeProfiles['enterprise-delivery'].phases.length, 7);
  assert.deepEqual(snapshot.initiatives, []);
  assert.equal(snapshot.workItems.length, 0);
  assert.equal(snapshot.approvalInbox.remote, 'origin');
  assert.deepEqual(snapshot.approvalInbox.items, []);
  assert.equal(snapshot.approvalInbox.fetched, false);
  assert.ok(snapshot.templates.some((item) => item.name === 'feature/design.md'));
  assert.ok(snapshot.personaPrompts.some((item) => item.name === 'architect.md'));
  assert.equal(snapshot.worldModel.repositoryOwned, true);
  assert.equal(snapshot.worldModel.views.length, 7);
  assert.ok(snapshot.worldModel.views.find((view) => view.id === 'architecture').structuredReferences.includes("persona 'architect' prompt"));
  assert.ok(snapshot.worldModel.views.find((view) => view.id === 'architecture').promptReferences.includes('singularity/prompts/worldmodel-builder.md'));
  assert.equal(snapshot.worldModelPrompt.path, 'singularity/prompts/worldmodel-builder.md');
  assert.equal(snapshot.worldModelPrompt.missing, false);
  assert.deepEqual(snapshot.repositorySkills, []);
  assert.ok(snapshot.agents.some((item) => item.id === 'sflow-workflow'));
  assert.equal(snapshot.agentsLock.path, 'singularity/agents.lock.yml');
  assert.ok(snapshot.agentStatus.some((item) => item.id === 'sflow-workflow'));
  assert.equal(snapshot.definition.sequenceGates.default, 'soft');
  assert.equal(snapshot.definition.sequenceGates.publicationPending, 'hard');

  run(process.execPath, [bin, 'start', 'DESK-1', '--title', 'Desktop workflow'], root);
  snapshot = await desktopSnapshot(root, 'DESK-1');
  assert.equal(snapshot.progress.currentPhase, 'intake');
  assert.equal(snapshot.progress.percentage, 0);
  assert.equal(snapshot.workflow.workItem.workType, 'feature');
  assert.equal(snapshot.workflow.resolution.sequenceGates.phaseStatus, 'soft');
  assert.ok(snapshot.documents.some((item) => item.id === 'SYS-WORKFLOW'));
  assert.equal(snapshot.report.cost, null);
  assert.equal(snapshot.report.costStatus, 'unavailable');
  assert.equal(snapshot.report.costCoverage.usageRecords, 0);
  assert.equal(snapshot.telemetry.exists, false);
  assert.ok(snapshot.telemetry.setup.path.endsWith('copilot-otel.sh'));

  const statePath = path.join(root, 'singularity/work-items/DESK-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.phases.intake.usage = [{
    status: 'exact', source: 'copilot-otel', provider: 'github', model: 'claude-sonnet-4.6',
    inputTokens: 1200, outputTokens: 300, cachedInputTokens: 200, totalTokens: 1500,
    providerCost: 0.0123, costStatus: 'exact', persona: 'product-owner'
  }];
  state.usage.exactRecords = 1;
  state.usage.unavailableRecords = 0;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  snapshot = await desktopSnapshot(root, 'DESK-1');
  assert.equal(snapshot.report.cost, 0.0123);
  assert.equal(snapshot.report.costStatus, 'exact');
  assert.equal(snapshot.report.tokens.total, 1500);
  assert.equal(snapshot.report.tokens.byModel[0].model, 'claude-sonnet-4.6');
  assert.equal(snapshot.report.tokens.byModel[0].providerCostRecords, 1);
  assert.equal(snapshot.report.costCoverage.pricedRecords, 1);
});

test('desktop snapshot exposes initiative phases, assurance, documents, telemetry, and configuration', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'initiative', 'start', 'INIT-DESK', '--title', 'Mobile experience'], root);
  const snapshot = await desktopSnapshot(root, null, 'INIT-DESK');
  assert.equal(snapshot.selectedInitiativeId, 'INIT-DESK');
  assert.equal(snapshot.initiative.state.initiative.profile, 'initiative-lite');
  assert.equal(snapshot.initiative.progress.phases.length, 4);
  assert.equal(snapshot.initiative.progress.currentPhase, 'define');
  assert.equal(snapshot.initiative.report.identityAssurance, 'configured-local');
  assert.equal(snapshot.initiative.report.telemetry.costStatus, 'unavailable');
  assert.ok(snapshot.initiative.phaseGate.checklist.some((check) => check.id === 'business-case-approved'));
  assert.ok(snapshot.initiative.documents.some((document) => document.id === 'business-case'));
  assert.match(snapshot.initiative.nextActions[0].command, /initiative phase define/);
  assert.ok(snapshot.initiatives.some((initiative) => initiative.id === 'INIT-DESK'));
});

test('desktop snapshot separates publishable configuration from unrelated changes', async () => {
  const root = await repository();
  const templatePath = 'singularity/templates/feature/design.md';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  await saveDesktopFile(root, templatePath, `${template}\nDesktop configuration change.\n`);
  await writeFile(path.join(root, 'README.md'), '# Unrelated source change\n');
  const snapshot = await desktopSnapshot(root);
  assert.deepEqual(snapshot.repository.configurationChanges, [templatePath]);
  assert.deepEqual(snapshot.repository.unrelatedChanges, ['README.md']);
  assert.equal(snapshot.repository.publishReady, false);
});

test('desktop treats a confirmed legacy control-root migration as publishable configuration', async () => {
  const root = await repository();
  await rename(path.join(root, 'singularity'), path.join(root, '.singularity'));
  run('git', ['add', '-A'], root);
  run('git', ['commit', '-m', 'legacy hidden control root'], root);

  const migration = await migrateLegacyConfig(root);
  assert.equal(migration.movedFrom, '.singularity');
  const snapshot = await desktopSnapshot(root);
  assert.equal(snapshot.repository.publishReady, true);
  assert.deepEqual(snapshot.repository.unrelatedChanges, []);
  assert.ok(snapshot.repository.configurationChanges.some((file) => file.startsWith('.singularity/')));
  assert.ok(snapshot.repository.configurationChanges.some((file) => file.startsWith('singularity/')));

  const published = await publishDesktopConfiguration(root, 'Move configuration to visible singularity folder');
  assert.equal(published.pushed, false);
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /visible singularity folder/);
});

test('desktop configuration saves validate atomically and publish scoped changes', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const original = await readFile(workflowPath, 'utf8');
  await assert.rejects(() => saveDesktopFile(root, 'singularity/workflow.yml', 'version: 9\n'), /validation failed/i);
  assert.equal(await readFile(workflowPath, 'utf8'), original);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const originalPortfolio = await readFile(portfolioPath, 'utf8');
  await assert.rejects(() => saveDesktopFile(root, 'singularity/portfolio.yml', 'version: 2\n'), /portfolio validation failed/i);
  assert.equal(await readFile(portfolioPath, 'utf8'), originalPortfolio);

  const templatePath = 'singularity/templates/feature/design.md';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  await saveDesktopFile(root, templatePath, `${template}\nDesktop-only design guidance.\n`);
  await assert.rejects(() => saveDesktopFile(root, 'singularity/agents.lock.yml', 'version: 1\nagents: {}\n'), /read-only/i);
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work.\n');
  await saveDesktopFile(root, '.github/agents/reviewer.agent.md', '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work carefully.\n');
  assert.equal((await validateDesktopConfiguration(root)).valid, true);
  const published = await publishDesktopConfiguration(root, 'Configure desktop template');
  assert.equal(published.pushed, false);
  assert.deepEqual(published.files.sort(), ['.github/agents/reviewer.agent.md', templatePath].sort());
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /Configure desktop template/);
});

test('desktop rolls back world-model view deletions while YAML or Markdown still refers to the view', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const originalWorkflow = await readFile(workflowPath, 'utf8');
  const definition = YAML.parse(originalWorkflow);
  definition.worldModel.views = definition.worldModel.views.filter((view) => view !== 'architecture');
  await assert.rejects(() => saveDesktopFile(root, 'singularity/workflow.yml', YAML.stringify(definition)), /architecture.*not declared/i);
  assert.equal(await readFile(workflowPath, 'utf8'), originalWorkflow);

  const promptPath = path.join(root, 'singularity/prompts/worldmodel-builder.md');
  const originalPrompt = await readFile(promptPath, 'utf8');
  await assert.rejects(() => saveDesktopFile(root, 'singularity/prompts/worldmodel-builder.md', `${originalPrompt}\nLoad views/unknown-governance.md.\n`), /unknown-governance.*not declared/i);
  assert.equal(await readFile(promptPath, 'utf8'), originalPrompt);
});

test('desktop creates templates and only deletes them when no workflow references them', async () => {
  const root = await repository();
  const templatePath = 'singularity/templates/custom/security-review.md';
  await saveDesktopFile(root, templatePath, '# {{work.id}} — Security review\n');
  assert.equal((await deleteDesktopTemplate(root, templatePath)).deleted, true);
  await assert.rejects(() => deleteDesktopTemplate(root, 'singularity/templates/feature/design.md'), /still referenced by/);
  await assert.rejects(() => deleteDesktopTemplate(root, 'README.md'), /restricted to/);
});

test('desktop manages repository prompts and skills and exports portable YAML and Markdown', async () => {
  const root = await repository();
  const skillPath = '.github/skills/security-review/SKILL.md';
  const skill = '---\nname: security-review\ndescription: Review repository security.\n---\n\n# Security review\n';
  await saveDesktopFile(root, skillPath, skill);
  const read = await readDesktopFile(root, skillPath);
  assert.equal(read.content, skill);
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), skill);
  assert.equal(read.bytes, Buffer.byteLength(skill));

  const snapshot = await desktopSnapshot(root);
  assert.ok(snapshot.repositorySkills.some((item) => item.path === skillPath));
  const bundle = await desktopExportBundle(root);
  assert.equal(bundle.worldModelRepositoryOwned, true);
  assert.ok(bundle.files.some((item) => item.path === 'singularity/workflow.yml'));
  assert.ok(bundle.files.some((item) => item.path === 'singularity/portfolio.yml'));
  assert.ok(bundle.files.some((item) => item.path === 'singularity/prompts/worldmodel-builder.md'));
  assert.ok(bundle.files.some((item) => item.path === skillPath));
  assert.equal((await deleteDesktopFile(root, skillPath)).deleted, true);
  await assert.rejects(() => readDesktopFile(root, 'README.md'), /not an exportable/i);
});

test('desktop persona selection remains local and requires the active work branch', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'DESK-2'], root);
  const session = await selectDesktopPersona(root, 'DESK-2', 'architect');
  assert.equal(session.persona, 'architect');
  assert.equal(session.workId, 'DESK-2');
  await assert.rejects(() => selectDesktopPersona(root, 'DESK-2', 'unknown'), /Unknown persona/);
});
