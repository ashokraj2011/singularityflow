import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType, snapshotResolution } from '../src/config.mjs';
import { renderAgentSkills } from '../src/agents.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { decisionOutcome } from '../src/workflow-decisions.mjs';
import { installWorkflow, simulateWorkflow } from '../src/workflow-catalog.mjs';
import { instructionPath, loadInstructionLibrary } from '../src/instruction-library.mjs';
import { loadSkillLibrary, librarySkillPath, librarySkillText } from '../src/skill-library.mjs';
import { packagedWorkflowSkills } from '../src/packaged-workflow-skills.mjs';
import { copyWorkflow, exportWorkflowBundle, planWorkflowCopy } from '../src/workflow-transfer.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { resolveStoryExecutionContext } from '../src/story-execution-context.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';
import { composePhasePrompt } from '../src/worldmodel.mjs';

const ID = 'demo-instruction-test-loop';
const PHASES = ['demo-instruction-intake', 'demo-instruction-test', 'demo-instruction-repair', 'demo-instruction-close'];
const AGENTS = ['demo-instruction-analyst', 'demo-instruction-tester', 'demo-instruction-developer', 'demo-instruction-closer'];
const SKILLS = ['demo-instruction-intake', 'demo-instruction-check', 'demo-instruction-repair', 'demo-instruction-close'];
const REFERENCES = ['demo-source-interpretation', 'demo-fresh-test-evidence', 'demo-reviewed-routing'];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root); return root;
}
async function withoutInstructionDemo(root) {
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8')); delete config.workTypes[ID];
  for (const id of PHASES) delete config.phases[id];
  await writeFile(file, YAML.stringify(config));
  for (const id of AGENTS) await rm(path.join(root, `.github/agents/${id}.agent.md`));
  for (const id of SKILLS) await rm(path.join(root, librarySkillPath(id)));
  for (const id of REFERENCES) await rm(path.join(root, instructionPath(id)));
}
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

test('instruction demo separates author/tester, writes code only in repair and always closes through documents', async t => {
  const root = await fixture(t); const resolved = resolveWorkType(await loadDefinition(root), ID);
  assert.deepEqual(resolved.phases.map(phase => phase.id), PHASES);
  assert.deepEqual(resolved.phases.map(phase => phase.defaultAgent), AGENTS);
  assert.deepEqual(resolved.phases.map(phaseRequiresCodeDelivery), [false, false, true, false]);
  assert.ok(resolved.phases.every(phase => phase.approval.mode === 'required'));
  assert.deepEqual(resolved.obligationGraph.findings, []);
  assert.notEqual((await simulateWorkflow(root, ID))[0].lifecycle.status, 'invalid');
  for (const [phaseId, values, target] of [
    [PHASES[1], { verdict: 'pass' }, PHASES[3]],
    [PHASES[1], { verdict: 'repair' }, PHASES[2]],
    [PHASES[1], { verdict: 'blocked' }, PHASES[1]],
    [PHASES[2], { next: 'recheck' }, PHASES[1]],
    [PHASES[2], { next: 'revise-intake' }, PHASES[0]]
  ]) {
    const decision = resolved.decisions.find(entry => entry.after === phaseId);
    const workflow = { resolution: resolved, phaseOrder: PHASES, phases: Object.fromEntries(resolved.phases.map(phase => [phase.id,
      { ...phase, status: 'awaiting_approval', generation: 1, decisionInputs: { decision: decision.id, values } }])) };
    assert.equal(decisionOutcome(workflow, workflow.phases[phaseId]).target, target);
    workflow.decisionRounds = { [decision.id]: { count: 3 } };
    if (PHASES.indexOf(target) <= PHASES.indexOf(phaseId)) assert.equal(decisionOutcome(workflow, workflow.phases[phaseId]).kind, 'pause');
  }
});

test('custom checker prompt receives three exact instructions in order, never in unrelated workflows or phases', async t => {
  const root = await fixture(t); const resolved = resolveWorkType(await loadDefinition(root), ID);
  const library = await loadSkillLibrary(root); const instructions = await loadInstructionLibrary(root);
  const value = library.skills.get(SKILLS[1]); assert.deepEqual(value.instructionRefs, REFERENCES);
  const workflow = { workItem: { id: 'DEMO-INS-1', workType: ID } };
  const rendered = await renderAgentSkills(root, workflow, resolved.phases[1], { agent: AGENTS[1] });
  assert.deepEqual(rendered.skills.map(skill => skill.id), [SKILLS[1]]);
  let prior = -1;
  for (const id of REFERENCES) {
    const item = instructions.instructions.get(id); const position = rendered.text.indexOf(item.instructions);
    assert.ok(position > prior, id); prior = position;
    assert.equal(rendered.text.split(item.instructions).length - 1, 1);
    assert.ok(rendered.text.includes(`sha256=${item.sha256}`));
  }
  assert.doesNotMatch(rendered.text, /<!-- sflow-instruction:/);
  const outside = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'feature' } }, { id: 'implementation' }, { agent: 'developer' });
  assert.doesNotMatch(outside.text, /Demo fresh test evidence|Demo reviewed routing/);
  const wrongPhase = await renderAgentSkills(root, workflow, resolved.phases[2], { agent: AGENTS[1] });
  assert.deepEqual(wrongPhase.skills, []);
});

test('starter adoption carries instruction closure without overwriting reviewed local definitions', async t => {
  const root = await fixture(t); await withoutInstructionDemo(root);
  const preview = await installWorkflow(root, ID, { dryRun: true });
  for (const id of REFERENCES) assert.ok(preview.files.includes(instructionPath(id)), id);
  await installWorkflow(root, ID);
  assert.deepEqual(resolveWorkType(await loadDefinition(root), ID).phases.map(phase => phase.defaultAgent), AGENTS);
  const item = path.join(root, instructionPath(REFERENCES[0]));
  const custom = (await readFile(item, 'utf8')) + '\nPreserve the team convention.\n';
  await writeFile(item, custom); await installWorkflow(root, ID, { replace: true });
  assert.equal(await readFile(item, 'utf8'), custom);
});

test('uninstalled optional demo agents cannot block any existing workflow catalog or ordinary Story snapshot', async t => {
  const root = await fixture(t); await withoutInstructionDemo(root);
  const definition = await loadDefinition(root);
  assert.ok(AGENTS.every(id => definition.agentCatalog.some(agent => agent.id === id && agent.scope === 'bundled')),
    'the upgraded package still discovers its new optional agents');
  for (const id of Object.keys(definition.workTypes)) {
    const selected = await snapshotResolution(root, definition, resolveWorkType(definition, id));
    for (const agent of AGENTS) assert.equal(selected.agents[agent], undefined, `${id} must not offer dormant ${agent}`);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Instruction Tester'); git(root, 'config', 'user.email', 'instruction@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'older approved configuration'); git(root, 'switch', '-c', 'ORDINARY-1');
  const config = await loadConfig(root); const resolved = resolveWorkType(config, 'spec-driven-standard');
  const workflow = await createWorkflow(root, config, { id: 'ORDINARY-1', title: 'Ordinary Story',
    baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner', resolved,
    source: { type: 'manual', key: 'ORDINARY-1', title: 'Ordinary Story', description: 'Keep the original workflow usable.', acceptanceCriteria: ['No optional demo dependency is required.'] } });
  const manifest = JSON.parse(await readFile(path.join(root, workflow.workflowSnapshot.manifestPath), 'utf8'));
  assert.ok(manifest.assets.some(asset => asset.logicalId === 'agent:product-owner'));
  assert.ok(manifest.assets.some(asset => asset.logicalId === 'agent:sflow-source-reviewer'));
  assert.ok(!manifest.assets.some(asset => /demo-instruction/.test(asset.logicalId)));
});

test('Story agent catalogs retain compatible alternatives, unscoped agents and explicit independent reviewers only', async t => {
  const root = await fixture(t); const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, 'spec-driven-standard');
  resolved.sourceReview = { ...resolved.sourceReview, reviewerAgent: 'review-bot' };
  const agent = (id, phases) => ({ id, phases, defaultFor: [], source: `${id}.md`, sha256: 'a'.repeat(64) });
  definition.agentCatalog.push(agent('alternative', ['implementation']), agent('unscoped', []),
    agent('unrelated', ['demo-instruction-test']), agent('review-bot', ['review-only']));
  const snapshot = await snapshotResolution(root, definition, resolved);
  for (const id of ['alternative', 'unscoped', 'review-bot']) assert.ok(snapshot.agents[id], id);
  assert.equal(snapshot.agents.unrelated, undefined);
  resolved.sourceReview.mode = 'off';
  assert.equal((await snapshotResolution(root, definition, resolved)).agents['review-bot'], undefined,
    'a disabled review policy cannot introduce an unrelated dependency');
});

test('canvas starter adoption includes agent skills and all referenced instructions atomically', async t => {
  const root = await fixture(t); await withoutInstructionDemo(root);
  const request = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'workflow.install', id: ID }] };
  const preview = await planStudioChangeSet(root, request);
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  for (const id of SKILLS) assert.ok(preview.files.some(file => file.path === librarySkillPath(id)), id);
  for (const id of REFERENCES) assert.ok(preview.files.some(file => file.path === instructionPath(id)), id);
  assert.equal((await loadSkillLibrary(root)).skills.has(SKILLS[0]), false, 'preview is read-only');
  await planStudioChangeSet(root, request, { write: true });
  assert.deepEqual(resolveWorkType(await loadDefinition(root), ID).phases.map(phase => phase.defaultAgent), AGENTS);
  const rendered = await renderAgentSkills(root, { workItem: { id: 'CANVAS', workType: ID } },
    { id: PHASES[1] }, { agent: AGENTS[1] });
  assert.match(rendered.text, /Use the approved repository test tool/);
  assert.doesNotMatch(rendered.text, /<!-- sflow-instruction:/);
});

test('starter dependency planning preserves valid repository-only agent skills instead of looking them up in the package', async t => {
  const root = await fixture(t); const id = 'repository-only';
  const file = path.join(root, librarySkillPath(id)); await mkdir(path.dirname(file), { recursive: true });
  const text = librarySkillText({ id, label: 'Repository skill', description: 'Team guidance for repository changes.',
    instructions: 'Follow the team convention.', instructionRefs: [REFERENCES[0]] });
  await writeFile(file, text);
  const files = await packagedWorkflowSkills(root, 'custom-workflow', new Set(), [{ id }]);
  assert.deepEqual(files, []); assert.equal(await readFile(file, 'utf8'), text);
});

test('canvas adoption resolves instructions from a skill created in that same atomic candidate', async t => {
  const root = await fixture(t); await withoutInstructionDemo(root);
  const changes = [
    { op: 'instruction.create', id: 'team-check-rule', description: 'Team checking rule.', instructions: 'Inspect the team-specific behavior.' },
    { op: 'skill.create', id: SKILLS[1], description: 'Team check policy.', instructions: 'Follow the explicit team check.', instructionRefs: ['team-check-rule'] },
    { op: 'workflow.install', id: ID }
  ];
  const request = { schema: STUDIO_CHANGE_SET_SCHEMA, changes };
  const preview = await planStudioChangeSet(root, request);
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  await planStudioChangeSet(root, request, { write: true });
  const skill = (await loadSkillLibrary(root)).skills.get(SKILLS[1]);
  assert.deepEqual(skill.instructionRefs, ['team-check-rule']);
  const rendered = await renderAgentSkills(root, { workItem: { id: 'ATOMIC', workType: ID } },
    { id: PHASES[1] }, { agent: AGENTS[1] });
  assert.match(rendered.text, /Inspect the team-specific behavior/);
});

test('independent workflow duplication exports instructions and rewrites all live placement identities', async t => {
  const root = await fixture(t); const before = await exportWorkflowBundle(root, [ID]);
  assert.deepEqual(before.assets.filter(asset => asset.kind === 'instruction').map(asset => asset.id).sort(), [...REFERENCES].sort());
  const request = { sourceId: ID, targetId: 'team-instruction-loop', label: 'Team instruction loop', independent: true };
  const preview = await planWorkflowCopy(root, request);
  assert.equal(preview.status, 'ready', JSON.stringify(preview.unresolved));
  await copyWorkflow(root, { ...request, expectedPlanSha256: preview.planSha256, resolutions: preview.resolutions });
  const copied = await exportWorkflowBundle(root, [request.targetId]);
  const refs = copied.assets.filter(asset => asset.kind === 'instruction').map(asset => asset.id);
  assert.equal(refs.length, 3); assert.ok(refs.every(id => !REFERENCES.includes(id)));
  for (const asset of copied.assets.filter(asset => asset.kind === 'skill')) {
    for (const original of REFERENCES) assert.ok(!asset.content.includes(`<!-- sflow-instruction: ${original} -->`));
  }
  const resolved = resolveWorkType(await loadDefinition(root), request.targetId);
  const rendered = await renderAgentSkills(root, { workItem: { id: 'COPY', workType: request.targetId } }, resolved.phases[1], { agent: resolved.phases[1].defaultAgent });
  assert.match(rendered.text, /Exact|Use the approved repository test tool/);
  assert.doesNotMatch(rendered.text, /<!-- sflow-instruction:/);
  assert.deepEqual((await exportWorkflowBundle(root, [ID])).assets, before.assets, 'original seeded assets stay unchanged');
});

test('a real Story snapshot pins placed instructions offline and protects seed definitions from editing', async t => {
  const root = await fixture(t); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Instruction Tester'); git(root, 'config', 'user.email', 'instruction@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture authority'); git(root, 'switch', '-c', 'DEMO-INS-1');
  const beforePreview = git(root, 'status', '--porcelain');
  const preview = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url)),
    'skill', 'show', SKILLS[1], '--json'], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const shown = JSON.parse(preview.stdout).skill;
  assert.deepEqual(shown.instructionRefs, REFERENCES);
  assert.doesNotMatch(shown.composedText, /<!-- sflow-instruction:/);
  for (const id of REFERENCES) assert.ok(shown.composedText.includes(`\`${id}\``));
  assert.equal(git(root, 'status', '--porcelain'), beforePreview, 'catalog composition preview is read-only');
  const config = await loadConfig(root); const resolved = resolveWorkType(config, ID);
  const workflow = await createWorkflow(root, config, { id: 'DEMO-INS-1', title: 'Instruction composition',
    baseBranch: 'main', workType: ID, agent: AGENTS[0], resolved,
    source: { type: 'manual', key: 'DEMO-INS-1', title: 'Instruction composition', description: 'Test supplied behavior then repair and retest.', acceptanceCriteria: ['Every agreed scenario is freshly tested.'] } });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'accepted Story');
  const manifest = JSON.parse(await readFile(path.join(root, workflow.workflowSnapshot.manifestPath), 'utf8'));
  assert.equal(manifest.semantics.promptComposer, 'story-snapshot-agent-v4');
  assert.equal(manifest.assets.filter(asset => asset.purpose === 'shared-instruction').length, 3);
  const prompt = await composePhasePrompt(root, { workId: workflow.workItem.id, phase: PHASES[0], agent: AGENTS[0] }, { renderOnly: true });
  assert.match(prompt, /Demo intake analyst/);
  assert.match(prompt, /Read only the pinned approved sources/);
  assert.match(prompt, /Propose pass only when every required scenario/);
  assert.doesNotMatch(prompt, /<!-- sflow-instruction:/);
  const context = await resolveStoryExecutionContext(root, config, workflow, { agentId: AGENTS[1], phaseId: PHASES[1] });
  const first = await renderAgentSkills(root, workflow, resolved.phases[1], { agent: AGENTS[1] }, { executionContext: context });
  await rm(path.join(root, 'singularity/instruction-library'), { recursive: true });
  const retained = await resolveStoryExecutionContext(root, config, workflow, { agentId: AGENTS[1], phaseId: PHASES[1] });
  const again = await renderAgentSkills(root, workflow, resolved.phases[1], { agent: AGENTS[1] }, { executionContext: retained });
  assert.equal(again.text, first.text);
  const protectedRoot = await fixture(t);
  const refused = await planStudioChangeSet(protectedRoot, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [
    { op: 'instruction.update', id: REFERENCES[0], instructions: 'Change the seeded interpretation.' }
  ] });
  assert.equal(refused.valid, false);
  assert.ok(refused.problems.some(error => error.code === 'SEEDED_WORKFLOW_READ_ONLY'), JSON.stringify(refused.problems));
});
