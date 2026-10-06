import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { discoverAgents, resolveCopilotAgent } from '../src/agents.mjs';
import { exportWorkflowBundle, planWorkflowImport, applyWorkflowImport, planWorkflowCopy, copyWorkflow } from '../src/workflow-transfer.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA, buildStudioModel } from '../src/workflow-studio.mjs';
import { librarySkillText, librarySkillPath } from '../src/skill-library.mjs';
import { stageImport, readStagedImport } from '../src/asset-import.mjs';
import { loadPortfolio, resolveInitiativeProfile } from '../src/initiative-config.mjs';
import { editPhase } from '../src/workflow-authoring.mjs';
import { WORKFLOW_STUDIO_SCRIPT } from '../apps/vscode/src/views/workflow-studio-page.ts';

process.env.NODE_ENV = 'test';
async function repo(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-identities-')); t.after(() => rm(root, { recursive: true, force: true })); await initializeDefinition(root); return root; }
const config = async (root) => YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
const save = async (root, value) => writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(value));

test('same-scope duplicate IDs refuse instead of hiding one agent; packaged shadowing still works', async (t) => {
  const root = await repo(t);
  const original = await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8');
  await writeFile(path.join(root, '.github/agents/duplicate.agent.md'), original);
  await assert.rejects(() => discoverAgents(root), { code: 'AGENT_ID_COLLISION' });
  await rm(path.join(root, '.github/agents/duplicate.agent.md'));
  assert.equal((await discoverAgents(root)).filter((agent) => agent.id === 'developer').length, 1);
});

test('independent duplication copies all editable contracts and native names without changing seeds', async (t) => {
  const root = await repo(t);
  const file = path.join(root, '.github/agents/developer.agent.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('name: developer', 'name: Feature Development Agent (No Jira)'));
  const before = await config(root), original = await readFile(file, 'utf8');
  const input = { sourceId: 'feature', targetId: 'my-feature', label: 'My feature', independent: true };
  const plan = await planWorkflowCopy(root, input);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.ok(plan.identities.some((row) => row.kind === 'agent'));
  assert.ok(plan.renamed.some((row) => row.subject === 'agent:developer'));
  await copyWorkflow(root, { ...input, expectedPlanSha256: plan.planSha256 });
  const after = await config(root);
  assert.deepEqual(after.workTypes.feature, before.workTypes.feature);
  assert.deepEqual(after.phases.implementation, before.phases.implementation);
  assert.ok(after.workTypes['my-feature'].phases.every((id) => !before.workTypes.feature.phases.includes(id)));
  assert.equal(await readFile(file, 'utf8'), original);
  await loadDefinition(root);
  const agents = await discoverAgents(root), renamed = plan.renamed.find((row) => row.subject === 'agent:developer').to;
  const imported = agents.find((agent) => agent.id === renamed);
  assert.notEqual(imported.displayName, agents.find((agent) => agent.id === 'developer').displayName);
  assert.equal((await resolveCopilotAgent(root, imported.displayName, { agents })).agent.id, renamed);
  const changed = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'workflow.update', id: 'my-feature', label: 'Personal feature' }] });
  assert.equal(changed.valid, true, JSON.stringify(changed.problems));
});

test('integration targets travel, can be renamed, and keep secret names rather than secret values', async (t) => {
  const source = await repo(t), target = await repo(t), value = await config(source);
  value.integrations = { targets: { 'team-events': { kind: 'webhook', url: 'https://events.example.test/hook', signingSecret: 'SFLOW_SECRET_TEAM_EVENTS_TOKEN' } } };
  value.workTypes['custom-flow'] = { ...structuredClone(value.workTypes.feature), label: 'Custom', phaseOverrides: { intake: { afterStep: [{ id: 'notify', on: ['approved'], target: 'team-events', send: 'event' }] } } };
  await save(source, value);
  const bundle = await exportWorkflowBundle(source, ['custom-flow']);
  assert.deepEqual(bundle.objects.story.integrations.targets, value.integrations.targets);
  const plan = await planWorkflowImport(target, bundle, { resolutions: { 'integration-target:team-events': { action: 'rename', to: 'other-events' } } });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions: plan.resolutions });
  const result = await config(target);
  assert.equal(result.workTypes['custom-flow'].phaseOverrides.intake.afterStep[0].target, 'other-events');
  assert.deepEqual(result.integrations.targets['other-events'], value.integrations.targets['team-events']);
});

test('seeded workflow, shared agent and template edits are refused, but people remain configurable', async (t) => {
  const root = await repo(t), model = await buildStudioModel(root);
  assert.equal(model.workflows.find((workflow) => workflow.id === 'feature').readOnly, true);
  for (const change of [
    { op: 'workflow.update', id: 'feature', label: 'Changed seed' },
    { op: 'phase.update', id: 'intake', label: 'Changed seed step' },
    { op: 'agent.update', id: 'developer', instructions: 'Different instructions.' }
  ]) {
    const result = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [change] });
    assert.equal(result.valid, false);
    assert.ok(result.problems.some((problem) => problem.code === 'SEEDED_WORKFLOW_READ_ONLY'), JSON.stringify(result.problems));
  }
  await assert.rejects(() => editPhase(root, 'intake', { label: 'Direct edit' }, { governs: 'story' }), { code: 'SEEDED_WORKFLOW_READ_ONLY' });
  const people = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'group.update', id: 'product-approvers', label: 'Product people' }] });
  assert.equal(people.valid, true, JSON.stringify(people.problems));
});

test('canonical Epic copies actually use their renamed agents and templates through local overrides', async (t) => {
  const root = await repo(t), before = await loadPortfolio(root);
  const input = { sourceId: 'initiative:epic-planning', targetId: 'my-epic', label: 'My Epic', independent: true };
  const plan = await planWorkflowCopy(root, input);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await copyWorkflow(root, { ...input, expectedPlanSha256: plan.planSha256 });
  const after = await loadPortfolio(root), resolved = resolveInitiativeProfile(after, 'my-epic');
  assert.deepEqual(after.initiativeProfiles['epic-planning'], before.initiativeProfiles['epic-planning']);
  assert.deepEqual(after.initiativePhases, before.initiativePhases);
  const renamed = plan.renamed.filter((entry) => entry.subject.startsWith('agent:')).map((entry) => entry.to);
  assert.ok(resolved.phases.some((phase) => phase.agents.some((id) => renamed.includes(id))), 'copied agents are used, not orphaned');
  assert.ok(resolved.phases.flatMap((phase) => phase.outputs).some((output) => /imported/.test(output.template)), 'copied templates are used');
  const model = await buildStudioModel(root), local = model.epics.workflows.find((workflow) => workflow.id === 'my-epic').localSteps;
  assert.ok(Object.values(local).some((phase) => phase.agents.some((id) => renamed.includes(id))));
  const window = { __sfVscode: { postMessage() {} }, addEventListener() {} };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, { getElementById: () => null });
  const logic = window.__workflowStudio, draft = logic.initialDraft(model);
  draft.epics.workflows['my-epic'].localSteps['epic-intake'].label = 'Our intake';
  const output = draft.epics.workflows['my-epic'].localSteps['epic-intake'].outputs[0];
  output.label = 'Our intake document';
  const changes = logic.changeSetFrom(model, draft);
  assert.deepEqual(changes.changes[0], { op: 'epicStep.update', id: 'epic-intake', workflow: 'my-epic', label: 'Our intake' });
  assert.equal(changes.changes[1].op, 'epicOutput.set');
  assert.equal(changes.changes[1].workflow, 'my-epic');
  const changed = await planStudioChangeSet(root, changes, { write: true });
  assert.equal(changed.valid, true, JSON.stringify(changed.problems));
  const updated = await loadPortfolio(root);
  assert.equal(resolveInitiativeProfile(updated, 'my-epic').phases[0].label, 'Our intake');
  assert.equal(resolveInitiativeProfile(updated, 'my-epic').phases[0].outputs[0].label, 'Our intake document');
  assert.deepEqual(updated.initiativePhases, before.initiativePhases);
  assert.deepEqual(updated.initiativeProfiles['epic-planning'], before.initiativeProfiles['epic-planning']);
  const clear = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{
    op: 'epicOutput.set', workflow: 'my-epic', step: 'epic-requirements', id: 'requirements-specification', template: ''
  }] });
  assert.equal(clear.valid, false);
  assert.ok(clear.problems.some((problem) => problem.code === 'STUDIO_EPIC_OUTPUT_INVALID'));
});

test('duplicate skill IDs can be renamed and agent attachments follow the new identity', async (t) => {
  const root = await repo(t), value = await config(root);
  value.workTypes['custom-flow'] = structuredClone(value.workTypes.feature); await save(root, value);
  const text = librarySkillText({ id: 'review-checklist', description: 'Review changes.', instructions: 'Check the changes against the specification.' });
  const skill = path.join(root, librarySkillPath('review-checklist')); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, text);
  const agentFile = path.join(root, '.github/agents/developer.agent.md');
  await writeFile(agentFile, (await readFile(agentFile, 'utf8')) + '\n## Attached skills\n\n| Skill | Phases | When to use it |\n| --- | --- | --- |\n| review-checklist | implementation | Review changes |\n');
  const input = { sourceId: 'custom-flow', targetId: 'other-flow', label: 'Other flow', independent: true,
    resolutions: { 'skill:review-checklist': { action: 'rename', to: 'other-checklist' } } };
  const plan = await planWorkflowCopy(root, input); assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await copyWorkflow(root, { ...input, expectedPlanSha256: plan.planSha256 });
  const renamed = plan.renamed.find((row) => row.subject === 'agent:developer').to;
  assert.equal((await discoverAgents(root)).find((agent) => agent.id === renamed).librarySkills[0].id, 'other-checklist');
});

test('raw agent and library-skill imports accept explicit new IDs with recorded transformations', async (t) => {
  const root = await repo(t);
  for (const [as, id, content, operation] of [
    ['agent', 'imported-reviewer', '---\nname: reviewer\ndescription: Reviews specifications\ntools: [read]\nmetadata:\n  sflow-phases: intake\n---\nReview the approved inputs.\n', 'import.agent'],
    ['skill', 'imported-checklist', librarySkillText({ id: 'checklist', description: 'Review specifications.', instructions: 'Check all acceptance criteria.' }), 'import.librarySkill']
  ]) {
    const staged = await stageImport(root, { bytes: Buffer.from(content), source: { kind: 'url', url: 'https://skills.example.test/asset.md' } });
    const imports = new Map([[staged.sha256, await readStagedImport(root, staged.sha256)]]);
    const plan = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: operation, id, sha256: staged.sha256 }] }, { imports });
    assert.equal(plan.valid, true, `${as}: ${JSON.stringify(plan.problems)}`);
  }
});
