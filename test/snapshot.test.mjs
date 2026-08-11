import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import YAML from 'yaml';
import {
  bootstrapWorkspacePortfolio,
  deleteConfigurationFile,
  deleteConfigurationTemplate,
  exportConfigurationBundle,
  repositorySnapshot,
  publishEditorConfiguration,
  readConfigurationFile,
  saveConfigurationFile,
  selectEditorAgent,
  validateEditorConfiguration
} from '../src/editor.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Editor Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' })
  };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-editor-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Editor Tester'], root);
  run('git', ['config', 'user.email', 'editor@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Editor test\n');
  run(process.execPath, [bin, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Editor Tester', email: 'editor@example.com' }];
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  // Leave one governed agent to resolve from the installed engine. This is the production shape
  // for repositories that use a packaged default without copying it into .github/agents.
  await unlink(path.join(root, '.github/agents/product-designer.agent.md'));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('snapshot exposes configuration and visual workflow data', async () => {
  const root = await repository();
  let snapshot = await repositorySnapshot(root);
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
  assert.ok(snapshot.agents.some((item) => item.id === 'architect' && item.path.endsWith('architect.agent.md')));
  assert.equal(snapshot.worldModel.repositoryOwned, true);
  assert.equal(snapshot.worldModel.views.length, 7);
  assert.ok(snapshot.worldModel.views.find((view) => view.id === 'architecture').structuredReferences.includes("agent 'architect' prompt"));
  assert.ok(snapshot.worldModel.views.find((view) => view.id === 'architecture').promptReferences.includes('singularity/prompts/worldmodel-builder.md'));
  assert.equal(snapshot.worldModelPrompt.path, 'singularity/prompts/worldmodel-builder.md');
  assert.equal(snapshot.worldModelPrompt.missing, false);
  assert.equal(snapshot.planning.enabled, true);
  assert.equal(snapshot.planning.config.promptSource, 'singularity/prompts/copilot-planning.md');
  assert.equal(snapshot.planning.prompt.missing, false);
  assert.match(snapshot.planning.prompt.content, /Stay in Copilot Plan mode/);
  assert.deepEqual(snapshot.planning.targets, []);
  assert.deepEqual(snapshot.repositorySkills, []);
  assert.ok(snapshot.flowSkills.length > 50);
  assert.deepEqual(
    Object.keys(snapshot.flowSkills[0]).sort(),
    ['argumentHint', 'bytes', 'command', 'content', 'description', 'id', 'name', 'packagePath', 'path', 'readOnly', 'repositoryPath', 'scope'].sort()
  );
  const startSkill = snapshot.flowSkills.find((item) => item.id === 'sflow-start');
  assert.equal(startSkill.command, '/sflow-start');
  assert.equal(startSkill.packagePath, 'plugin/skills/sflow-start/SKILL.md');
  assert.equal(startSkill.repositoryPath, '.github/skills/sflow-start/SKILL.md');
  assert.equal(startSkill.readOnly, true);
  assert.match(startSkill.description, /workflow template; activate its phase-default agent/i);
  assert.ok(snapshot.agents.some((item) => item.id === 'sflow-workflow'));
  const packagedAgent = snapshot.agents.find((item) => item.id === 'product-designer');
  assert.equal(packagedAgent.scope, 'bundled');
  assert.equal(packagedAgent.packagePath, 'templates/agents/product-designer.agent.md');
  assert.doesNotMatch(packagedAgent.packagePath, /(^|\/)\.\.(\/|$)/);
  assert.equal(snapshot.agentsLock.path, 'singularity/agents.lock.yml');
  assert.equal(snapshot.agentMappings.path, 'singularity/agent-mappings.yml');
  assert.equal(snapshot.agentMappings.exists, true);
  assert.match(snapshot.agentMappings.content, /mappings: \{\}/);
  assert.ok(snapshot.agentMappings.rows.some((row) => row.copilotAgent === 'sflow-workflow' && row.source === 'same-name fallback'));
  assert.ok(snapshot.agentStatus.some((item) => item.id === 'sflow-workflow'));
  assert.equal(snapshot.definition.sequenceGates.default, 'soft');
  assert.equal(snapshot.definition.sequenceGates.publicationPending, 'hard');

  run(process.execPath, [bin, 'start', 'DESK-1', '--ref', 'story/DESK-1-editor', '--title', 'Editor workflow'], root);
  snapshot = await repositorySnapshot(root);
  assert.equal(snapshot.selectedWorkId, 'DESK-1');
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
    status: 'exact', source: 'copilot-otel', provider: 'github', model: 'model-alpha-1',
    inputTokens: 1200, outputTokens: 300, cachedInputTokens: 200, totalTokens: 1500,
    providerCost: 0.0123, costStatus: 'exact', agent: 'product-owner'
  }];
  state.usage.exactRecords = 1;
  state.usage.unavailableRecords = 0;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  snapshot = await repositorySnapshot(root, 'DESK-1');
  assert.equal(snapshot.report.cost, 0.0123);
  assert.equal(snapshot.report.costStatus, 'exact');
  assert.equal(snapshot.report.tokens.total, 1500);
  assert.equal(snapshot.report.tokens.byModel[0].model, 'model-alpha-1');
  assert.equal(snapshot.report.tokens.byModel[0].providerCostRecords, 1);
  assert.equal(snapshot.report.costCoverage.pricedRecords, 1);
});

test('scoped snapshots construct only the requested schema-v2 slice', async () => {
  const root = await repository();
  const snapshot = await repositorySnapshot(root, null, null, { included: ['repository', 'capabilities'] });
  assert.deepEqual(Object.keys(snapshot), ['repository', 'capabilities']);
  assert.equal(snapshot.repository.branch, 'main');
  assert.equal(snapshot.capabilities.path, 'singularity/capabilities.yml');
  assert.equal(Object.hasOwn(snapshot, 'configuration'), false);
  assert.equal(Object.hasOwn(snapshot, 'lifecycle'), false);

  const cli = run(process.execPath, [bin, 'snapshot', '--include', 'repository', '--json'], root);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.schemaVersion, 2);
  assert.deepEqual(envelope.included, ['repository']);
  assert.equal(envelope.repository.branch, 'main');
  assert.equal(Object.hasOwn(envelope, 'configuration'), false);
});

test('lifecycle snapshots keep generated phase artifacts regardless of lifecycle status', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'ARTIFACTS-1', '--title', 'Visible generated artifacts'], root);
  const statePath = path.join(root, 'singularity/work-items/ARTIFACTS-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const artifactPath = path.join(
    root,
    'singularity/work-items/ARTIFACTS-1',
    state.phases.intake.requiredArtifact.path
  );
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, '# Intake\n\nGenerated intake evidence.\n');

  let scoped = await repositorySnapshot(root, 'ARTIFACTS-1', null, { included: ['lifecycle'] });
  let artifact = scoped.lifecycle.documents.find((document) => document.id === 'PHASE-INTAKE');
  assert.equal(artifact?.status, 'in_progress');
  assert.equal(artifact?.phase, 'intake');

  state.phases.intake.status = 'approved';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  scoped = await repositorySnapshot(root, 'ARTIFACTS-1', null, { included: ['lifecycle'] });
  artifact = scoped.lifecycle.documents.find((document) => document.id === 'PHASE-INTAKE');
  assert.equal(artifact?.status, 'approved');
  assert.equal(scoped.lifecycle.documents.filter((document) => document.type === 'system').length, 5);
});

test('lifecycle catalog includes a completed Story stored on a sibling branch', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'ARCHIVE-1', '--title', 'Archived delivery'], root);
  const statePath = path.join(root, 'singularity/work-items/ARCHIVE-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.status = 'complete';
  state.currentPhase = null;
  for (const phase of Object.values(state.phases)) phase.status = 'approved';
  state.history.push({ event: 'workflow-completed', at: '2026-08-05T00:00:00.000Z' });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  run('git', ['add', statePath], root);
  run('git', ['commit', '-m', 'Complete archived Story'], root);
  run('git', ['switch', 'main'], root);

  const scoped = await repositorySnapshot(root, null, null, { included: ['lifecycle'] });
  const archived = scoped.lifecycle.workItems.find((item) => item.id === 'ARCHIVE-1');
  assert.equal(archived.status, 'complete');
  assert.equal(archived.branch, 'ARCHIVE-1');
  assert.equal(archived.source, 'ARCHIVE-1');
  assert.equal(scoped.lifecycle.selectedWorkId, null);
});

test('configuration inventory remains visible when a legacy workflow blocks lifecycle loading', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(workflowPath, 'utf8'));
  legacy.version = 1;
  await writeFile(workflowPath, YAML.stringify(legacy));

  await assert.rejects(() => repositorySnapshot(root), /version must be 2/);
  const scoped = await repositorySnapshot(root, null, null, { included: ['configuration'] });
  assert.equal(scoped.configuration.configurationValid, false);
  assert.match(scoped.configuration.configurationError, /version must be 2/);
  assert.equal(scoped.configuration.definition.version, 1);
  assert.ok(scoped.configuration.flowSkills.length > 50);
  assert.ok(scoped.configuration.agents.some((agent) => agent.id === 'architect'));
  assert.ok(scoped.configuration.templates.length > 0);
  assert.ok(scoped.configuration.agentPrompts.length > 0);
});

test('visual editor bootstraps governed portfolio and Jira policy without storing credentials', async () => {
  const root = await repository();
  await unlink(path.join(root, 'singularity/portfolio.yml'));
  const created = await bootstrapWorkspacePortfolio(root, {
    approvalName: 'Portfolio Owner',
    approvalEmail: 'Owner@Example.com',
    repository: {
      id: 'mobile',
      url: 'git@git.example.corp:company/mobile.git',
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
  const snapshot = await repositorySnapshot(root);
  assert.equal(snapshot.portfolio.jira.enabled, true);
  assert.ok(snapshot.repository.configurationChanges.includes('singularity/portfolio.yml'));
  await assert.rejects(() => bootstrapWorkspacePortfolio(root), /already exists/i);
});

test('visual editor safely repairs an untouched starter portfolio with empty authority groups', async () => {
  const root = await repository();
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const starter = YAML.parse(await readFile(portfolioPath, 'utf8'));
  for (const authority of Object.values(starter.approvalAuthorities)) authority.members = [];
  await writeFile(portfolioPath, YAML.stringify(starter));

  const repaired = await bootstrapWorkspacePortfolio(root, {
    replaceEmptyStarter: true,
    repositories: {
      lead: {
        url: 'https://git.example.corp/company/lead.git',
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-1', name: 'Lead' }
      }
    }
  });
  assert.equal(repaired.repairedEmptyStarter, true);
  assert.equal(repaired.updatedExisting, true);
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  assert.ok(Object.values(portfolio.approvalAuthorities)
    .every((authority) => authority.members[0].email === 'editor@example.com'));
  assert.equal(portfolio.repositories.lead.metadata.appId, 'APP-1');

  portfolio.approvalAuthorities['product-approvers'].members = [{
    name: 'Configured Owner',
    email: 'owner@example.com'
  }];
  portfolio.approvalAuthorities['risk-reviewers'].members = [];
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  const merged = await bootstrapWorkspacePortfolio(root, { replaceEmptyStarter: true });
  assert.equal(merged.updatedExisting, true);
  assert.equal(merged.repairedEmptyStarter, true);
  const mergedPortfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  assert.deepEqual(mergedPortfolio.approvalAuthorities['product-approvers'].members, [{
    name: 'Configured Owner',
    email: 'owner@example.com'
  }]);
  assert.equal(
    mergedPortfolio.approvalAuthorities['risk-reviewers'].members[0].email,
    'editor@example.com'
  );
});

test('visual editor bootstraps all workspace repositories and Jira project routes together', async () => {
  const root = await repository();
  await unlink(path.join(root, 'singularity/portfolio.yml'));
  const created = await bootstrapWorkspacePortfolio(root, {
    repositories: {
      lead: {
        url: 'https://git.example.corp/company/lead.git',
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-1', name: 'Lead' }
      },
      mobile: {
        url: 'https://git.example.corp/company/mobile.git',
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

test('snapshot exposes initiative phases, assurance, documents, telemetry, and configuration', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'initiative', 'start', 'INIT-DESK', '--title', 'Mobile experience'], root);
  const snapshot = await repositorySnapshot(root, null, 'INIT-DESK');
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

test('snapshot separates publishable configuration from unrelated changes', async () => {
  const root = await repository();
  const templatePath = 'singularity/templates/feature/design.md';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  await saveConfigurationFile(root, templatePath, `${template}\nEditor configuration change.\n`);
  await writeFile(path.join(root, 'README.md'), '# Unrelated source change\n');
  const snapshot = await repositorySnapshot(root);
  assert.deepEqual(snapshot.repository.configurationChanges, [templatePath]);
  assert.deepEqual(snapshot.repository.unrelatedChanges, ['README.md']);
  assert.equal(snapshot.repository.publishReady, false);
});

test('visual editor configuration saves validate atomically and publish scoped changes', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const original = await readFile(workflowPath, 'utf8');
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/workflow.yml', 'version: 9\n'), /validation failed/i);
  assert.equal(await readFile(workflowPath, 'utf8'), original);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const originalPortfolio = await readFile(portfolioPath, 'utf8');
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/portfolio.yml', 'version: 2\n'), /portfolio validation failed/i);
  assert.equal(await readFile(portfolioPath, 'utf8'), originalPortfolio);

  const templatePath = 'singularity/templates/feature/design.md';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  await saveConfigurationFile(root, templatePath, `${template}\nEditor-only design guidance.\n`);
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/agents.lock.yml', 'version: 1\nagents: {}\n'), /read-only/i);
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work.\n');
  await saveConfigurationFile(root, '.github/agents/reviewer.agent.md', '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work carefully.\n');
  const mappingPath = path.join(root, 'singularity/agent-mappings.yml');
  const originalMappings = await readFile(mappingPath, 'utf8');
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/agent-mappings.yml', 'version: 1\nmappings:\n  enterprise-reviewer: missing-pack\n'), /unknown governed agent/i);
  assert.equal(await readFile(mappingPath, 'utf8'), originalMappings);
  await saveConfigurationFile(root, 'singularity/agent-mappings.yml', 'version: 1\nmappings:\n  enterprise-reviewer: reviewer\n');
  await assert.rejects(() => deleteConfigurationFile(root, '.github/agents/reviewer.agent.md'), /Copilot agent mapping enterprise-reviewer/);
  assert.equal((await validateEditorConfiguration(root)).valid, true);
  const published = await publishEditorConfiguration(root, 'Configure visual editor template');
  assert.equal(published.pushed, false);
  assert.deepEqual(published.files.sort(), ['.github/agents/reviewer.agent.md', 'singularity/agent-mappings.yml', templatePath].sort());
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /Configure visual editor template/);
});

test('visual editor rejects a stale configuration revision without overwriting concurrent edits', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const rendered = await readFile(workflowPath, 'utf8');
  const expectedSha256 = createHash('sha256').update(rendered).digest('hex');
  const concurrent = `${rendered}\n# concurrent repository edit\n`;
  await writeFile(workflowPath, concurrent);

  await assert.rejects(
    () => saveConfigurationFile(root, 'singularity/workflow.yml', rendered, { expectedSha256 }),
    /changed since the editor loaded/i
  );
  assert.equal(await readFile(workflowPath, 'utf8'), concurrent);
});

test('visual editor can create an absent optional configuration file from an empty rendered revision', async () => {
  const root = await repository();
  const impactPath = path.join(root, 'singularity/impact.yml');
  const content = await readFile(impactPath, 'utf8');
  await unlink(impactPath).catch(() => {});
  const expectedSha256 = createHash('sha256').update('').digest('hex');

  await saveConfigurationFile(root, 'singularity/impact.yml', content, { expectedSha256 });

  assert.equal(await readFile(impactPath, 'utf8'), content);
});

test('invalid configuration candidates are validated before replacing governed files', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const original = await readFile(workflowPath, 'utf8');
  const definition = YAML.parse(original);
  definition.worldModel.views = definition.worldModel.views.filter((view) => view !== 'architecture');
  const before = await stat(workflowPath, { bigint: true });

  await assert.rejects(
    () => saveConfigurationFile(root, 'singularity/workflow.yml', YAML.stringify(definition)),
    /architecture.*not declared/i
  );

  const after = await stat(workflowPath, { bigint: true });
  assert.equal(await readFile(workflowPath, 'utf8'), original);
  assert.equal(after.ino, before.ino, 'validation must not replace the governed file with a staged candidate');
  assert.equal(after.mtimeNs, before.mtimeNs, 'validation must not touch the governed file before success');
});

test('Flow Impact configuration is editable through the governed configuration API', async () => {
  const root = await repository();
  const impactPath = path.join(root, 'singularity/impact.yml');
  const original = await readFile(impactPath, 'utf8');
  const definition = YAML.parse(original);
  definition.studies[0].enabled = true;
  await saveConfigurationFile(root, 'singularity/impact.yml', YAML.stringify(definition));
  assert.equal(YAML.parse(await readFile(impactPath, 'utf8')).studies[0].enabled, true);
  await assert.rejects(
    () => saveConfigurationFile(root, 'singularity/impact.yml', 'version: 1\nstudies: []\nunknown: true\n'),
    /Flow Impact configuration validation failed/i
  );
  assert.equal(YAML.parse(await readFile(impactPath, 'utf8')).studies[0].enabled, true,
    'an invalid replacement leaves the last valid configuration untouched');
});

test('visual editor rolls back world-model view deletions while YAML or Markdown still refers to the view', async () => {
  const root = await repository();
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const originalWorkflow = await readFile(workflowPath, 'utf8');
  const definition = YAML.parse(originalWorkflow);
  definition.worldModel.views = definition.worldModel.views.filter((view) => view !== 'architecture');
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/workflow.yml', YAML.stringify(definition)), /architecture.*not declared/i);
  assert.equal(await readFile(workflowPath, 'utf8'), originalWorkflow);

  const promptPath = path.join(root, 'singularity/prompts/worldmodel-builder.md');
  const originalPrompt = await readFile(promptPath, 'utf8');
  await assert.rejects(() => saveConfigurationFile(root, 'singularity/prompts/worldmodel-builder.md', `${originalPrompt}\nLoad views/unknown-governance.md.\n`), /unknown-governance.*not declared/i);
  assert.equal(await readFile(promptPath, 'utf8'), originalPrompt);
});

test('visual editor creates templates and only deletes them when no workflow references them', async () => {
  const root = await repository();
  const templatePath = 'singularity/templates/custom/security-review.md';
  await saveConfigurationFile(root, templatePath, '# {{work.id}} — Security review\n');
  assert.equal((await deleteConfigurationTemplate(root, templatePath)).deleted, true);
  await assert.rejects(() => deleteConfigurationTemplate(root, 'singularity/templates/feature/design.md'), /still referenced by/);
  await assert.rejects(() => deleteConfigurationTemplate(root, 'README.md'), /restricted to/);
});

test('visual editor manages repository prompts and skills and exports portable YAML and Markdown', async () => {
  const root = await repository();
  const skillPath = '.github/skills/security-review/SKILL.md';
  const skill = '---\nname: security-review\ndescription: Review repository security.\n---\n\n# Security review\n';
  await saveConfigurationFile(root, skillPath, skill);
  const read = await readConfigurationFile(root, skillPath);
  assert.equal(read.content, skill);
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), skill);
  assert.equal(read.bytes, Buffer.byteLength(skill));

  const snapshot = await repositorySnapshot(root);
  assert.ok(snapshot.repositorySkills.some((item) => item.path === skillPath));
  const bundled = snapshot.flowSkills.find((item) => item.id === 'sflow-status');
  await saveConfigurationFile(root, bundled.repositoryPath, `${bundled.content}\n<!-- Repository customization -->\n`);
  const customized = await repositorySnapshot(root);
  assert.ok(customized.repositorySkills.some((item) => item.path === bundled.repositoryPath));
  assert.equal(customized.flowSkills.find((item) => item.id === 'sflow-status').readOnly, true);
  const bundle = await exportConfigurationBundle(root);
  assert.equal(bundle.worldModelRepositoryOwned, true);
  assert.ok(bundle.files.some((item) => item.path === 'singularity/workflow.yml'));
  assert.ok(bundle.files.some((item) => item.path === 'singularity/portfolio.yml'));
  assert.ok(bundle.files.some((item) => item.path === 'singularity/prompts/worldmodel-builder.md'));
  assert.ok(bundle.files.some((item) => item.path === 'singularity/prompts/copilot-planning.md'));
  assert.ok(bundle.files.some((item) => item.path === skillPath));
  assert.equal((await deleteConfigurationFile(root, skillPath)).deleted, true);
  await assert.rejects(() => readConfigurationFile(root, 'README.md'), /not an exportable/i);
});

test('visual editor configuration refuses symlinked files and parent directories outside the repository', async () => {
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-editor-outside-'));
  const secret = path.join(outside, 'secret.md');
  await writeFile(secret, '# outside secret\n');

  const linkedSkill = path.join(root, '.github', 'skills', 'linked', 'SKILL.md');
  await mkdir(path.dirname(linkedSkill), { recursive: true });
  await symlink(secret, linkedSkill);
  await assert.rejects(
    () => readConfigurationFile(root, '.github/skills/linked/SKILL.md'),
    /symbolic link/
  );
  await unlink(linkedSkill);

  const escapedRoot = path.join(root, '.github', 'skills', 'escaped');
  await symlink(outside, escapedRoot, 'dir');
  await assert.rejects(
    () => saveConfigurationFile(root, '.github/skills/escaped/CREATED.md', '# must stay local\n'),
    /symbolic link|outside the repository/
  );
  await assert.rejects(
    () => repositorySnapshot(root),
    /symbolic link|outside the repository/
  );
  await assert.rejects(
    () => exportConfigurationBundle(root),
    /symbolic link|outside the repository/
  );
  await unlink(escapedRoot);
  await symlink(secret, linkedSkill);
  await assert.rejects(
    () => deleteConfigurationFile(root, '.github/skills/linked/SKILL.md'),
    /symbolic link/
  );
  assert.equal(await readFile(secret, 'utf8'), '# outside secret\n');
});

test('visual editor agent selection remains local and requires the active work branch', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'DESK-2'], root);
  const session = await selectEditorAgent(root, 'DESK-2', 'architect');
  assert.equal(session.agent, 'architect');
  assert.equal(session.workId, 'DESK-2');
  await assert.rejects(() => selectEditorAgent(root, 'DESK-2', 'unknown'), /Unknown governed agent/);
});

test('configuration publish --json emits machine-readable stdout even when git commits and pushes', async () => {
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
  git(['switch', '-c', 'sflow/config-change/test-publish'], root);

  const definitionPath = path.join(root, 'singularity/workflow.yml');
  await writeFile(definitionPath, `${await readFile(definitionPath, 'utf8')}\n# publishable tweak\n`);

  const execution = spawnSync(process.execPath, [bin, 'configuration', 'publish', '--message', 'test publish', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  // Git progress must not contaminate stdout; the editor parses it as JSON.
  const parsed = JSON.parse(execution.stdout);
  assert.equal(parsed.pushed, true);
  assert.deepEqual(parsed.files, ['singularity/workflow.yml']);
  // The human-readable git output is still emitted, on stderr.
  assert.match(execution.stderr, /\[sflow\/config-change\/test-publish [0-9a-f]+\]/);
});
