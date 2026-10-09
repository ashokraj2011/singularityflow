import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { parseAgentDependencies } from '../src/agents.mjs';
import { initializeDefinition } from '../src/config.mjs';
import {
  CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, withStoryConfigurationSnapshotRead
} from '../src/configuration-branch.mjs';
import { canonicalJson } from '../src/records.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';
import {
  compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256,
  validateConfiguredSkillPhase
} from '../src/skp-contract.mjs';
import { inspectSkillPackage } from '../src/skp-package.mjs';
import { run } from '../src/util.mjs';
import {
  applyWorkflowImport, exportWorkflowBundle, planWorkflowImport, readWorkflowBundle
} from '../src/workflow-transfer.mjs';

process.env.NODE_ENV = 'test';
const H = (digit) => `sha256:${digit.repeat(64)}`;
const digest = (value) => `sha256:${createHash('sha256')
  .update(JSON.stringify(JSON.parse(canonicalJson(value)))).digest('hex')}`;

function rehash(bundle) {
  const core = structuredClone(bundle);
  delete core.bundleSha256;
  bundle.bundleSha256 = digest(core);
  return bundle;
}

async function config(root) {
  return YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
}

async function saveConfig(root, value) {
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(value));
}

async function fixture(t, { sourcePaths = [] } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-transfer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  await mkdir(source);
  await mkdir(target);
  await initializeDefinition(source);
  await initializeDefinition(target);
  const directory = path.join(source, 'singularity/skills/threat-model');
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  const entryBytes = Buffer.from('# Threat model\r\nRead [checklist](references/checklist.md).\r\n');
  const referenceBytes = Buffer.from('Exact reviewed checklist.\r\n');
  const binaryBytes = Buffer.from([0, 255, 13, 10, 128, 1]);
  await writeFile(path.join(directory, 'SKILL.md'), entryBytes);
  await writeFile(path.join(directory, 'references/checklist.md'), referenceBytes);
  await writeFile(path.join(directory, 'assets/example.bin'), binaryBytes);
  await writeFile(path.join(source, 'singularity/.gitattributes'), 'skills/** -text\n');
  const capture = await inspectSkillPackage(directory);
  const definition = await config(source);
  definition.version = 3;
  const order = [...definition.workTypes.feature.phases];
  order.splice(order.indexOf('requirements') + 1, 0, 'threat-model');
  const authoring = {
    id: 'threat-model', kind: 'skill', label: 'Threat model',
    skill: { id: 'threat-model', packageSha256: capture.manifest.packageSha256 },
    contract: {
      task: 'analyze',
      consumes: [{ phase: 'requirements', output: 'primary', required: true, state: 'approved' }],
      produces: [{
        id: 'report', path: 'artifacts/threat-model/report.md', kind: 'custom:threat-model',
        mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 4096,
        clauses: 'optional', claimRole: 'findings'
      }],
      checks: ['git-diff-check'], writeScope: 'artifact-only',
      readScope: { inputs: true, sourcePaths },
      approval: { authorities: ['engineering-reviewers'], minimum: 1 }
    }
  };
  const catalog = {
    skillPackages: { 'threat-model': {
      packageSha256: capture.manifest.packageSha256, eligibility: 'candidate-producer'
    } },
    phases: { requirements: { outputs: [{
      id: 'primary', path: definition.phases.requirements.artifact.path
    }] } },
    checks: { 'git-diff-check': { id: 'git-diff-check', argv: ['git', 'diff', '--check'], modelPolicy: 'never' } },
    approvalAuthorities: { 'engineering-reviewers': definition.approvalAuthorities['engineering-reviewers'] },
    approvalSecurity: definition.approvalSecurity, readPaths: sourcePaths,
    sourceScopes: {}, artifactSets: {}
  };
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const compiled = compileConfirmedSkillPhase({ phase: authoring, catalog, phaseOrder: order,
    confirmation: {
      contractSha256: skillContractSha256(authoring.id, authoring.contract), catalogSha256,
      packageSha256: authoring.skill.packageSha256,
      candidateSha256: skillPhaseCandidateSha256(authoring, order, catalogSha256),
      planSha256: H('b'), draftRevision: 1
    } });
  definition.phases['threat-model'] = configurationPhaseFromCompiledSkill(compiled);
  definition.workTypes['skill-mixed-feature'] = {
    ...structuredClone(definition.workTypes.feature), label: 'Reviewed skill feature', phases: order
  };
  await saveConfig(source, definition);
  const targetDefinition = await config(target);
  targetDefinition.version = 3;
  await saveConfig(target, targetDefinition);
  await writeFile(path.join(source, '.github/agents/threat-producer.agent.md'), `---
name: threat-producer
description: Produce the reviewed threat model.
tools: []
metadata:
  sflow-phases: threat-model
  sflow-default-for: threat-model
---
# Threat producer
Follow the reviewed contract and current host restrictions.
`);
  run('git', ['init', '-q', '-b', CONFIGURATION_BRANCH], { cwd: source });
  run('git', ['config', 'user.name', 'Transfer Reviewer'], { cwd: source });
  run('git', ['config', 'user.email', 'transfer@example.invalid'], { cwd: source });
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'approve complete skill workflow'], { cwd: source });
  const approved = await loadStoryConfigurationSnapshot({ remote: source, branch: CONFIGURATION_BRANCH });
  const exportBundle = () => withStoryConfigurationSnapshotRead(source, approved,
    () => exportWorkflowBundle(source, ['story:skill-mixed-feature']));
  return { base, source, target, directory, approved, exportBundle, compiled,
    capture, entryBytes, referenceBytes, binaryBytes };
}

test('export import / equivalent retained package and compiled binding with exact binary bytes', async (t) => {
  const value = await fixture(t);
  await rm(value.directory, { recursive: true, force: true });
  const bundle = await value.exportBundle();
  assert.equal(bundle.schemaVersion, 8);
  assert.equal(currentSchemaVersion('workflow-bundle'), 8);
  assert.deepEqual(bundle.skillPackages[0].manifest, value.capture.manifest);
  assert.equal(bundle.skillPackages[0].source.commit, value.approved.sourceCommit);
  assert.deepEqual(bundle.skillPackages[0].phaseBindings.map((entry) => entry.phaseId), ['threat-model']);
  assert.equal(bundle.skillPackages[0].phaseBindings[0].compilationSha256, value.compiled.compilationSha256);
  const before = await config(value.target);
  const plan = await planWorkflowImport(value.target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  assert.equal(plan.sharedDependencies.skillPackages, 1);
  assert.equal(plan.sharedDependencies.skillFiles, 3);
  assert.ok(plan.changedPaths.includes('singularity/skills/threat-model/assets/example.bin'));
  assert.ok(plan.changedPaths.includes('singularity/.gitattributes'));
  const result = await applyWorkflowImport(value.target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(result.status, 'imported');
  const after = await config(value.target);
  assert.deepEqual(after.phases['threat-model'], bundle.objects.story.phases['threat-model']);
  assert.deepEqual(after.approvalAuthorities, before.approvalAuthorities);
  assert.deepEqual(after.model, before.model);
  assert.deepEqual(after.codeDelivery, before.codeDelivery);
  const retained = await inspectSkillPackage(path.join(value.target, 'singularity/skills/threat-model'), {
    expectedPackageSha256: value.capture.manifest.packageSha256
  });
  assert.deepEqual(retained.manifest, value.capture.manifest);
  assert.deepEqual(retained.contents.get('SKILL.md'), value.entryBytes);
  assert.deepEqual(retained.contents.get('references/checklist.md'), value.referenceBytes);
  assert.deepEqual(retained.contents.get('assets/example.bin'), value.binaryBytes);
  assert.equal((await planWorkflowImport(value.target, bundle)).counts.add, 0);

  run('git', ['init', '-q', '-b', CONFIGURATION_BRANCH], { cwd: value.target });
  run('git', ['config', 'user.name', 'Target Reviewer'], { cwd: value.target });
  run('git', ['config', 'user.email', 'target@example.invalid'], { cwd: value.target });
  run('git', ['config', 'core.autocrlf', 'true'], { cwd: value.target });
  await writeFile(path.join(value.target, '.gitattributes'), '* text=auto\n');
  run('git', ['add', '-A'], { cwd: value.target });
  run('git', ['commit', '-qm', 'approve imported exact package'], { cwd: value.target });
  for (const [relative, bytes] of [
    ['SKILL.md', value.entryBytes], ['references/checklist.md', value.referenceBytes],
    ['assets/example.bin', value.binaryBytes]
  ]) {
    assert.deepEqual(run('git', ['show', `HEAD:singularity/skills/threat-model/${relative}`], {
      cwd: value.target, encoding: 'buffer'
    }).stdout, bytes);
  }
  const approvedTarget = await loadStoryConfigurationSnapshot({ remote: value.target, branch: CONFIGURATION_BRANCH });
  const roundtrip = await withStoryConfigurationSnapshotRead(value.target, approvedTarget,
    () => exportWorkflowBundle(value.target, ['story:skill-mixed-feature']));
  assert.deepEqual(roundtrip.skillPackages[0].manifest, bundle.skillPackages[0].manifest);
  assert.deepEqual(roundtrip.skillPackages[0].files, bundle.skillPackages[0].files);
  assert.deepEqual(roundtrip.skillPackages[0].phaseBindings, bundle.skillPackages[0].phaseBindings);
});

test('missing, tampered, extra, duplicate, or relabelled packages fail before target writes', async (t) => {
  const value = await fixture(t);
  const bundle = await value.exportBundle();
  const before = await readFile(path.join(value.target, 'singularity/workflow.yml'));
  for (const edit of [
    (record) => { record.skillPackages = []; },
    (record) => { record.skillPackages[0].files.pop(); },
    (record) => { record.skillPackages[0].files[0].content = Buffer.from('tampered').toString('base64'); },
    (record) => { record.skillPackages[0].files.push(structuredClone(record.skillPackages[0].files[0])); },
    (record) => { record.skillPackages[0].phaseBindings[0].contractSha256 = H('d'); },
    (record) => { record.skillPackages[0].source.allowedTools = ['shell']; },
    (record) => { record.skillPackages[0].manifest.parserProfile = 'unknown/v1'; },
    (record) => { record.skillPackages[0].files[0].content += '\n'; },
    (record) => { record.skillPackages.push(structuredClone(record.skillPackages[0])); },
    (record) => { record.objects.story.phases['threat-model'].artifact.minimumBytes += 1; },
    (record) => { record.semantics.skillTextParser = 'unknown/v1'; },
    (record) => { record.schemaVersion = 1; }
  ]) {
    const changed = structuredClone(bundle);
    edit(changed);
    rehash(changed);
    await assert.rejects(() => planWorkflowImport(value.target, changed));
    await assert.rejects(() => applyWorkflowImport(value.target, changed, { expectedPlanSha256: H('0') }));
    assert.deepEqual(await readFile(path.join(value.target, 'singularity/workflow.yml')), before);
  }
});

test('target admission never imports reviewer, check, agent-tool, or source-read grants', async (t) => {
  const value = await fixture(t);
  const bundle = await value.exportBundle();
  const before = await config(value.target);
  const wrongReviewers = structuredClone(before);
  wrongReviewers.approvalAuthorities['engineering-reviewers'].members = [{
    name: 'Target reviewer', email: 'target@example.invalid'
  }];
  await saveConfig(value.target, wrongReviewers);
  let plan = await planWorkflowImport(value.target, bundle);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some((entry) => entry.code === 'SKP_TARGET_PERMISSION_UNAPPROVED'));
  await assert.rejects(() => applyWorkflowImport(value.target, bundle, { expectedPlanSha256: plan.planSha256 }),
    { code: 'WORKFLOW_IMPORT_CONFLICT' });
  assert.deepEqual(await config(value.target), wrongReviewers);

  const noChecks = structuredClone(before);
  for (const phase of Object.values(noChecks.phases)) phase.qualityCommands = [];
  for (const workflow of Object.values(noChecks.workTypes)) {
    for (const phase of Object.values(workflow.phaseOverrides ?? {})) delete phase.qualityCommands;
  }
  await saveConfig(value.target, noChecks);
  plan = await planWorkflowImport(value.target, bundle);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some((entry) => entry.code === 'SKP_TARGET_PERMISSION_UNAPPROVED'));

  await saveConfig(value.target, before);
  const toolRequest = structuredClone(bundle);
  const agent = toolRequest.assets.find((entry) => entry.id === 'threat-producer');
  agent.content = agent.content.replace('tools: []', 'tools: [shell]');
  agent.size = Buffer.byteLength(agent.content);
  agent.sha256 = `sha256:${createHash('sha256').update(agent.content).digest('hex')}`;
  rehash(toolRequest);
  plan = await planWorkflowImport(value.target, toolRequest);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some((entry) => entry.code === 'SKP_TARGET_PERMISSION_UNAPPROVED'));

  const readValue = await fixture(t, { sourcePaths: ['src/application.mjs'] });
  const readBundle = await readValue.exportBundle();
  plan = await planWorkflowImport(readValue.target, readBundle);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some((entry) => entry.code === 'SKP_TARGET_PERMISSION_UNAPPROVED'));
  const admitted = await config(readValue.target);
  admitted.phases['threat-model'] = structuredClone(readBundle.objects.story.phases['threat-model']);
  await saveConfig(readValue.target, admitted);
  plan = await planWorkflowImport(readValue.target, readBundle);
  assert.equal(plan.status, 'ready', 'an exact prior target effect binding may be reused');
});

test('self-rehashed skill bundles cannot widen a non-default or compatibility-override agent', async (t) => {
  const value = await fixture(t);
  const bundle = await value.exportBundle();
  const before = await readFile(path.join(value.target, 'singularity/workflow.yml'));
  const developerPath = path.join(value.target, '.github/agents/developer.agent.md');
  // The destination's packaged developer remains approved, but its absent repository override
  // leaves a new file to import. A same-path collision must not be what protects its tool limits.
  await rm(developerPath);
  for (const compatible of [true, false]) {
    const changed = structuredClone(bundle);
    const agent = changed.assets.find((entry) => entry.id === 'developer');
    agent.content = agent.content.replace(/^tools:.*$/mu, 'tools: [unapproved-shell]');
    if (compatible) {
      agent.content = agent.content.replace(/^([ \t]+sflow-phases:).*$/mu,
        '$1 "implement,implementation,threat-model"');
    }
    agent.size = Buffer.byteLength(agent.content);
    agent.sha256 = `sha256:${createHash('sha256').update(agent.content).digest('hex')}`;
    rehash(changed);
    const parsed = parseAgentDependencies(agent.content, { source: agent.path, agentId: agent.id });
    assert.equal(parsed.defaultFor.includes('threat-model'), false);
    assert.equal(parsed.phases.includes('threat-model'), compatible);
    assert.equal(validateConfiguredSkillPhase(changed.objects.story.phases['threat-model'],
      'threat-model').compilationSha256, value.compiled.compilationSha256,
    'the exact compiler binding remains valid; matching hashes cannot grant tools');
    const plan = await planWorkflowImport(value.target, changed);
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.conflicts.some((entry) => entry.code === 'SKP_TARGET_PERMISSION_UNAPPROVED'
      && entry.reason.includes("agent 'developer'")));
    await assert.rejects(() => applyWorkflowImport(value.target, changed,
      { expectedPlanSha256: plan.planSha256 }), { code: 'WORKFLOW_IMPORT_CONFLICT' });
    assert.deepEqual(await readFile(path.join(value.target, 'singularity/workflow.yml')), before);
    await assert.rejects(() => readFile(developerPath), { code: 'ENOENT' });
  }
});

test('target dialect and package membership are checked by preview and reconfirmation', async (t) => {
  const value = await fixture(t);
  const bundle = await value.exportBundle();
  const definition = await config(value.target);
  definition.version = 2;
  await saveConfig(value.target, definition);
  const incompatible = await planWorkflowImport(value.target, bundle);
  assert.equal(incompatible.status, 'blocked');
  assert.ok(incompatible.conflicts.some((entry) => entry.code === 'SKP_TARGET_POLICY_INCOMPATIBLE'));
  definition.version = 3;
  const normalTemplateRoot = definition.templatesRoot;
  definition.templatesRoot = 'singularity/skills/threat-model';
  await saveConfig(value.target, definition);
  const contaminated = await planWorkflowImport(value.target, bundle);
  assert.equal(contaminated.status, 'blocked');
  assert.ok(contaminated.conflicts.some((entry) => entry.kind === 'skill-package'));
  definition.templatesRoot = normalTemplateRoot;
  await saveConfig(value.target, definition);
  const plan = await planWorkflowImport(value.target, bundle);
  assert.equal(plan.status, 'ready');
  const directory = path.join(value.target, 'singularity/skills/threat-model');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'unclaimed.md'), 'unreviewed membership\n');
  const changed = await planWorkflowImport(value.target, bundle);
  assert.equal(changed.status, 'blocked');
  assert.ok(changed.conflicts.some((entry) => entry.kind === 'skill-package'));
  await assert.rejects(() => applyWorkflowImport(value.target, bundle, { expectedPlanSha256: plan.planSha256 }),
    { code: 'WORKFLOW_TRANSFER_PLAN_STALE' });
  await assert.rejects(() => readFile(path.join(directory, 'SKILL.md')), { code: 'ENOENT' });
});

test('live matching bytes cannot replace an approved snapshot, and v1 keeps its original identity', async (t) => {
  const value = await fixture(t);
  await assert.rejects(() => exportWorkflowBundle(value.source, ['story:skill-mixed-feature']),
    { code: 'SKP_APPROVED_CONFIGURATION_REQUIRED' });
  // A v3 export with the new MCP closure cannot be relabelled as a historical one-pass bundle.
  // Isolate this v1 identity fixture from shared MCP scopes; the transfer suite covers real
  // historical v1/v2 inventories with unresolved auxiliary scope phases separately.
  const historical = await config(value.target);
  const exportOnly = structuredClone(historical);
  exportOnly.mcpServers = {};
  await saveConfig(value.target, exportOnly);
  const ordinary = await exportWorkflowBundle(value.target, ['story:feature']);
  await saveConfig(value.target, historical);
  ordinary.schemaVersion = 1;
  delete ordinary.skillPackages;
  delete ordinary.semantics;
  delete ordinary.imports;
  delete ordinary.workflowSkillAttachments;
  delete ordinary.objects.story.integrations;
  rehash(ordinary);
  const file = path.join(value.base, 'historical-v1.json');
  await writeFile(file, JSON.stringify(ordinary));
  const before = await readFile(file);
  const opened = await readWorkflowBundle(file);
  assert.deepEqual(opened, ordinary);
  assert.equal(opened.schemaVersion, 1);
  assert.equal(opened.bundleSha256, ordinary.bundleSha256);
  assert.deepEqual(await readFile(file), before);
  const historicalPlan = await planWorkflowImport(value.target, opened);
  assert.equal(historicalPlan.status, 'ready', JSON.stringify(historicalPlan.conflicts));
  const migration = readRecord('workflow-bundle', ordinary);
  assert.equal(migration.storedVersion, 1);
  assert.deepEqual(migration.record.skillPackages, []);
  assert.equal(migration.record.bundleSha256, ordinary.bundleSha256);
});
