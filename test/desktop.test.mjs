import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  bootstrapDesktopPortfolio,
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
  assert.equal(snapshot.planning.enabled, true);
  assert.equal(snapshot.planning.config.promptSource, 'singularity/prompts/copilot-planning.md');
  assert.equal(snapshot.planning.prompt.missing, false);
  assert.match(snapshot.planning.prompt.content, /Stay in Copilot Plan mode/);
  assert.deepEqual(snapshot.planning.targets, []);
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
  assert.equal(snapshot.planning.targets[0].scope, 'work-item');
  assert.equal(snapshot.planning.targets[0].currentPhase, 'intake');
  assert.equal(snapshot.planning.targets[0].phases[0].targets[0].id, 'artifact');

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

test('desktop bootstraps governed portfolio and Jira policy without storing credentials', async () => {
  const root = await repository();
  await unlink(path.join(root, 'singularity/portfolio.yml'));
  const created = await bootstrapDesktopPortfolio(root, {
    approvalName: 'Portfolio Owner',
    approvalEmail: 'Owner@Example.com',
    repository: {
      id: 'mobile',
      url: 'git@github.com:company/mobile.git',
      defaultBranch: 'develop',
      required: true,
      metadata: {
        appId: 'APP-1001',
        name: 'Mobile application',
        owner: 'Digital Channels'
      }
    },
    jira: {
      enabled: true,
      deployment: 'cloud',
      baseUrl: 'https://company.atlassian.net',
      projectKey: 'app',
      writeMode: 'preview',
      token: 'must-never-be-written'
    }
  });
  assert.equal(created.path, 'singularity/portfolio.yml');
  assert.equal(created.approver.email, 'owner@example.com');
  assert.equal(created.repositoryConfigured, true);
  assert.equal(created.jiraConfigured, true);
  const content = await readFile(path.join(root, created.path), 'utf8');
  assert.doesNotMatch(content, /must-never-be-written/);
  const portfolio = YAML.parse(content);
  assert.equal(portfolio.repositories.mobile.defaultBranch, 'develop');
  assert.deepEqual(portfolio.repositories.mobile.metadata, {
    appId: 'APP-1001',
    name: 'Mobile application',
    owner: 'Digital Channels'
  });
  assert.deepEqual(portfolio.jira.allowedHosts, ['company.atlassian.net']);
  assert.deepEqual(portfolio.jira.allowedProjects, ['APP']);
  assert.equal(portfolio.jira.writeMode, 'preview');
  assert.equal(portfolio.jira.write, false);
  assert.ok(Object.values(portfolio.approvalAuthorities).every((authority) => authority.members[0].email === 'owner@example.com'));
  const snapshot = await desktopSnapshot(root);
  assert.equal(snapshot.portfolio.jira.enabled, true);
  assert.ok(snapshot.repository.configurationChanges.includes('singularity/portfolio.yml'));
  await assert.rejects(() => bootstrapDesktopPortfolio(root), /already exists/i);
});

test('desktop bootstraps all workspace repositories and Jira project routes together', async () => {
  const root = await repository();
  await unlink(path.join(root, 'singularity/portfolio.yml'));
  const created = await bootstrapDesktopPortfolio(root, {
    repositories: {
      lead: {
        url: 'https://github.com/company/lead.git',
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-1', name: 'Lead' }
      },
      mobile: {
        url: 'https://github.com/company/mobile.git',
        defaultBranch: 'develop',
        required: true,
        metadata: { appId: 'APP-2', name: 'Mobile' }
      }
    },
    jira: {
      enabled: true,
      connection: 'corporate-jira',
      deployment: 'cloud',
      baseUrl: 'https://company.atlassian.net',
      projectKey: 'KAN',
      allowedProjects: ['KAN', 'MOB'],
      writeMode: 'approved'
    }
  });
  assert.equal(created.repositoryConfigured, true);
  const portfolio = YAML.parse(await readFile(path.join(root, created.path), 'utf8'));
  assert.deepEqual(Object.keys(portfolio.repositories), ['lead', 'mobile']);
  assert.deepEqual(portfolio.jira.allowedProjects, ['KAN', 'MOB']);
  assert.equal(portfolio.jira.projectKey, 'KAN');
  assert.equal(portfolio.jira.writeMode, 'approved');
  assert.equal(portfolio.jira.write, true);
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
  assert.deepEqual(snapshot.initiative.breakdown.epics, []);
  assert.equal(snapshot.initiative.materialization.epics, 0);
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
  assert.ok(bundle.files.some((item) => item.path === 'singularity/prompts/copilot-planning.md'));
  assert.ok(bundle.files.some((item) => item.path === skillPath));
  assert.equal((await deleteDesktopFile(root, skillPath)).deleted, true);
  await assert.rejects(() => readDesktopFile(root, 'README.md'), /not an exportable/i);
});

test('desktop configuration refuses symlinked files and parent directories outside the repository', async () => {
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-outside-'));
  const secret = path.join(outside, 'secret.md');
  await writeFile(secret, '# outside secret\n');

  const linkedSkill = path.join(root, '.github', 'skills', 'linked', 'SKILL.md');
  await mkdir(path.dirname(linkedSkill), { recursive: true });
  await symlink(secret, linkedSkill);
  await assert.rejects(
    () => readDesktopFile(root, '.github/skills/linked/SKILL.md'),
    /symbolic link/
  );
  await unlink(linkedSkill);

  const escapedRoot = path.join(root, '.github', 'skills', 'escaped');
  await symlink(outside, escapedRoot, 'dir');
  await assert.rejects(
    () => saveDesktopFile(root, '.github/skills/escaped/CREATED.md', '# must stay local\n'),
    /symbolic link|outside the repository/
  );
  await assert.rejects(
    () => desktopSnapshot(root),
    /symbolic link|outside the repository/
  );
  await assert.rejects(
    () => desktopExportBundle(root),
    /symbolic link|outside the repository/
  );
  await unlink(escapedRoot);
  await symlink(secret, linkedSkill);
  await assert.rejects(
    () => deleteDesktopFile(root, '.github/skills/linked/SKILL.md'),
    /symbolic link/
  );
  assert.equal(await readFile(secret, 'utf8'), '# outside secret\n');
});

test('desktop persona selection remains local and requires the active work branch', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'DESK-2'], root);
  const session = await selectDesktopPersona(root, 'DESK-2', 'architect');
  assert.equal(session.persona, 'architect');
  assert.equal(session.workId, 'DESK-2');
  await assert.rejects(() => selectDesktopPersona(root, 'DESK-2', 'unknown'), /Unknown persona/);
});

test('desktop publish --json emits machine-readable stdout even when git commits and pushes', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-publish-json-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const git = (args, cwd) => {
    const outcome = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(outcome.status, 0, `git ${args.join(' ')}\n${outcome.stderr}`);
    return outcome.stdout;
  };
  git(['init', '--bare', '-b', 'main', remote], base);
  git(['init', '-b', 'main', root], base);
  git(['config', 'user.name', 'Publish Tester'], root);
  git(['config', 'user.email', 'publish@example.com'], root);
  spawnSync(process.execPath, [bin, 'init'], { cwd: root, encoding: 'utf8' });
  await writeFile(path.join(root, 'README.md'), '# Publish\n');
  git(['add', '-A'], root);
  git(['commit', '-m', 'initialize'], root);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);

  const definitionPath = path.join(root, 'singularity/workflow.yml');
  await writeFile(definitionPath, `${await readFile(definitionPath, 'utf8')}\n# publishable tweak\n`);

  const execution = spawnSync(process.execPath, [bin, 'desktop', 'publish', '--message', 'test publish', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  // Git progress must not contaminate stdout; the desktop parses it as JSON.
  const parsed = JSON.parse(execution.stdout);
  assert.equal(parsed.pushed, true);
  assert.deepEqual(parsed.files, ['singularity/workflow.yml']);
  // The human-readable git output is still emitted, on stderr.
  assert.match(execution.stderr, /\[main [0-9a-f]+\]/);
});
