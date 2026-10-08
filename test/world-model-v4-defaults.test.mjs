import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { resolveInitiativeProfile, validatePortfolio, validatePortfolioWorldModelViews } from '../src/initiative-config.mjs';
import { addPhase } from '../src/workflow-authoring.mjs';
import { agentRolePresets } from '../src/workflow-studio.mjs';
import { BUILTIN_VIEW_IDS, BUILTIN_VIEW_REFERENCES } from '../src/world-model/registry/views.mjs';
import { applyWorkflowImport, copyWorkflow, exportWorkflowBundle, planWorkflowCopy, planWorkflowImport } from '../src/workflow-transfer.mjs';
import { initializeLegacyWorldModelDefinition } from './helpers/legacy-world-model.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-v4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await initializeDefinition(root);
  return root;
}

function nativeAssignments(views, label) {
  assert.ok((views ?? []).every(view => BUILTIN_VIEW_IDS.includes(view)), label);
}

test('every packaged Story, Initiative and agent resolves native v4 without the legacy bridge', async t => {
  const root = await repository(t);
  const definition = await loadDefinition(root);
  assert.equal(definition.worldModel.format, 'registered-v4');
  assert.equal(definition.worldModel.v4.legacyAssignments, 'strict');
  assert.equal(definition.worldModel.v4.composer, 'deterministic');
  assert.deepEqual(definition.worldModel.views, BUILTIN_VIEW_REFERENCES);
  assert.equal(definition.worldModel.promptSource, 'builtin', 'v3 builder prose is not an active dependency');
  for (const [id, agent] of Object.entries(definition.agents)) {
    nativeAssignments(agent.worldModelViews, `agent ${id}`);
  }
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    for (const phase of resolved.phases) {
      nativeAssignments(phase.worldModel?.views, `${id}/${phase.id}`);
    }
  }
  for (const id of ['poc-lite', 'benchmarking-b']) {
    assert.equal(resolveWorkType(definition, id).intelligence.worldModel, 'off', id);
  }
  const portfolio = validatePortfolio(YAML.parse(await readFile(path.join(root, 'singularity/portfolio.yml'), 'utf8')));
  assert.equal(validatePortfolioWorldModelViews(portfolio, definition), true);
  for (const id of Object.keys(portfolio.initiativeProfiles)) {
    const resolved = resolveInitiativeProfile(portfolio, id, { workflowDefinition: definition });
    for (const phase of resolved.phases) nativeAssignments(phase.worldModelViews, `${id}/${phase.id}`);
  }
});

test('new-agent role presets use only enabled native contracts; explicit legacy repositories keep legacy presets', () => {
  const native = { worldModel: { format: 'registered-v4', views: ['dev.impact@4'] } };
  const roles = agentRolePresets(native);
  assert.deepEqual(roles.find(role => role.id === 'developer').views, ['dev.impact']);
  assert.deepEqual(roles.find(role => role.id === 'architect').views, []);
  assert.ok(roles.every(role => role.views.every(view => view === 'dev.impact')));
  const draftRoles = agentRolePresets({ ...native,
    phases: { draft: { worldModel: { views: ['arch.contracts'] } } } });
  assert.deepEqual(draftRoles.find(role => role.id === 'architect').views, [],
    'an undeclared draft reference is not an enabled preset');
  const all = agentRolePresets({ worldModel: { format: 'registered-v4' } });
  assert.deepEqual(all.find(role => role.id === 'architect').views, ['arch.contracts']);
  const legacy = agentRolePresets({ worldModel: { format: 'legacy-v3', views: ['architecture'] } });
  assert.deepEqual(legacy.find(role => role.id === 'architect').views, ['architecture']);
});

test('CLI phase authoring validates native Story and Initiative selections before writing', async t => {
  const root = await repository(t);
  for (const governs of ['story', 'initiative']) {
    const file = path.join(root, governs === 'story' ? 'singularity/workflow.yml' : 'singularity/portfolio.yml');
    const before = await readFile(file, 'utf8');
    await assert.rejects(() => addPhase(root, `invalid-${governs}`, {
      governs, worldModelViews: ['testing']
    }), /undeclared|Unsupported entries/i);
    assert.equal(await readFile(file, 'utf8'), before);
    if (governs === 'story') await writeFile(path.join(root, '.github/agents/native-story.agent.md'),
      '---\nname: Native story\ndescription: Draft the native Story phase.\ntools: [read, edit, bash]\nmetadata:\n  sflow-phases: native-story\n  sflow-default-for: native-story\n  sflow-world-model-views: dev.impact\n---\nDraft the configured artifact from governed inputs.\n');
    await addPhase(root, `native-${governs}`, { governs, worldModelViews: ['dev.impact'] });
    const value = YAML.parse(await readFile(file, 'utf8'));
    assert.deepEqual(governs === 'story' ? value.phases['native-story'].worldModel.views
      : value.initiativePhases['native-initiative'].worldModelViews, ['dev.impact']);
  }
});

test('native workflow copy and export/import retain phase-scoped v4 assignments', async t => {
  const source = await repository(t);
  const target = await repository(t);
  const copy = await planWorkflowCopy(source, { sourceId: 'feature', targetId: 'native-feature', label: 'Native feature' });
  assert.equal(copy.status, 'ready', JSON.stringify(copy.conflicts));
  await copyWorkflow(source, { sourceId: 'feature', targetId: 'native-feature', label: 'Native feature', expectedPlanSha256: copy.planSha256 });
  const bundle = await exportWorkflowBundle(source, ['native-feature']);
  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  const definition = await loadDefinition(target);
  const copied = resolveWorkType(definition, 'native-feature');
  const seeded = resolveWorkType(definition, 'feature');
  for (const phase of copied.phases) {
    nativeAssignments(phase.worldModel?.views, phase.id);
    assert.deepEqual(phase.worldModel?.views, seeded.phases.find(entry => entry.id === phase.id)?.worldModel?.views);
  }
});

test('cross-document view refusal does not leave a Story starter template behind', async t => {
  const root = await repository(t);
  await writeFile(path.join(root, '.github/agents/native-note.agent.md'),
    '---\nname: Native note\ndescription: Draft the note.\ntools: [read, edit]\nmetadata:\n  sflow-phases: native-note\n  sflow-default-for: native-note\n---\nDraft the configured note.\n');
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  portfolio.initiativePhases.define.worldModelViews = ['testing'];
  await writeFile(file, YAML.stringify(portfolio));
  const workflow = path.join(root, 'singularity/workflow.yml');
  const before = await readFile(workflow, 'utf8');
  await assert.rejects(addPhase(root, 'native-note', { governs: 'story' }), { code: 'WMB_VIEW_UNKNOWN' });
  assert.equal(await readFile(workflow, 'utf8'), before);
  await assert.rejects(access(path.join(root, 'singularity/templates/common/native-note.md')), { code: 'ENOENT' });
});

test('importing a legacy workflow into native strict v4 never invents aliases or rewrites target policy', async t => {
  const source = await repository(t);
  const target = await repository(t);
  await initializeLegacyWorldModelDefinition(source);
  const copyOptions = { sourceId: 'feature', targetId: 'legacy-feature', label: 'Legacy feature' };
  const copy = await planWorkflowCopy(source, copyOptions);
  assert.equal(copy.status, 'ready');
  await copyWorkflow(source, { ...copyOptions, expectedPlanSha256: copy.planSha256 });
  const bundle = await exportWorkflowBundle(source, ['legacy-feature']);
  const before = await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8');
  const plan = await planWorkflowImport(target, bundle, { resolveAll: 'rename' });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some(item => /world-model|worldModel|views/i.test(item.reason)));
  await assert.rejects(() => applyWorkflowImport(target, bundle, {
    resolutions: plan.resolutions, expectedPlanSha256: plan.planSha256
  }), { code: 'WORKFLOW_IMPORT_CONFLICT' });
  assert.equal(await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8'), before);
  assert.equal((await loadDefinition(target)).worldModel.v4.legacyAssignments, 'strict');
});

test('file-only reinitialization refuses incompatible agent upgrades before changing any bytes', async t => {
  const root = await repository(t);
  await initializeLegacyWorldModelDefinition(root);
  const workflow = path.join(root, 'singularity/workflow.yml');
  const agent = path.join(root, '.github/agents/architect.agent.md');
  const before = [await readFile(workflow, 'utf8'), await readFile(agent, 'utf8')];
  await assert.rejects(initializeDefinition(root), error => {
    assert.equal(error.code, 'WMB_SEED_MIGRATION_REQUIRED');
    assert.ok(error.details.assignments.some(item => item.path.endsWith('/architect.agent.md')));
    const recovery = refusalRemediationPlan(error, ['init', '--repair', '--json']);
    assert.ok(recovery.steps.some(step => step.command?.includes('--migrate-world-model --dry-run')
      && step.copilotCommand?.startsWith('/sf-admin')));
    return true;
  });
  assert.deepEqual([await readFile(workflow, 'utf8'), await readFile(agent, 'utf8')], before);
  const value = YAML.parse(before[0]);
  value.worldModel.format = 'registered-v4';
  value.worldModel.views = ['dev.impact@4'];
  value.worldModel.v4 = { legacyAssignments: 'inherit-configured' };
  await writeFile(workflow, YAML.stringify(value));
  const narrowed = await readFile(workflow, 'utf8');
  await assert.rejects(initializeDefinition(root), { code: 'WMB_SEED_MIGRATION_REQUIRED' });
  assert.equal(await readFile(workflow, 'utf8'), narrowed);
  assert.equal(await readFile(agent, 'utf8'), before[1]);
});
