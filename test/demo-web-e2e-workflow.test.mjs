import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { authoringRoute, phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { renderAgentSkills } from '../src/agents.mjs';
import { applicabilityStatus } from '../src/evidence/applicability.mjs';
import { decisionOutcome, pendingDecisionRecord, resolveDecisionChoice } from '../src/workflow-decisions.mjs';
import { installWorkflow, simulateWorkflow, workflowCatalog } from '../src/workflow-catalog.mjs';
import { exportWorkflowBundle, applyWorkflowImport, planWorkflowImport } from '../src/workflow-transfer.mjs';
import { librarySkillPath, loadSkillLibrary, parseSkillAttachments, SKILL_ATTACHMENTS_PATH, skillAttachmentsText } from '../src/skill-library.mjs';
import { packagedWorkflowSkills } from '../src/packaged-workflow-skills.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'demo-web-e2e-testing';
const PHASES = ['demo-web-intake', 'demo-web-check', 'demo-web-repair', 'demo-web-retest'];
const AGENTS = ['demo-web-analyst', 'demo-web-tester', 'demo-web-developer'];
const SKILLS = ['demo-web-screenshot-intake', 'demo-web-screenshot-check', 'demo-web-defect-repair'];
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-demo-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}
function aggregate(resolution, phaseId, verdict, rounds = 0) {
  const decision = resolution.decisions.find((entry) => entry.after === phaseId);
  return { resolution, phaseOrder: PHASES, phases: Object.fromEntries(resolution.phases.map((phase) =>
    [phase.id, { ...phase, generation: 1, status: phase.id === phaseId ? 'awaiting_approval' : 'approved',
      ...(phase.id === phaseId ? { decisionInputs: { decision: decision.id, values: { verdict } } } : {}) }])),
    decisionRounds: { [decision.id]: { count: rounds } } };
}

test('demo starter pins private phases, custom agents, scoped browser tools and usable contracts', async (t) => {
  const root = await temporary(t);
  const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, ID);
  assert.deepEqual(resolved.phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), [AGENTS[0], AGENTS[1], AGENTS[2], AGENTS[1]]);
  assert.deepEqual(resolved.phases.map((phase) => authoringRoute(phase).effectiveAuthoringSkill),
    ['/sf-document-intake', '/sf-scenario-check', '/sf-code', '/sf-scenario-check']);
  assert.deepEqual(resolved.phases.map(phaseRequiresCodeDelivery), [false, false, true, false]);
  assert.deepEqual(resolved.phases.map((phase) => phase.writeScope), ['artifact-only', 'artifact-only', 'source-and-artifact', 'artifact-only']);
  assert.ok(resolved.phases.every((phase) => phase.approval.mode === 'required'));
  assert.deepEqual(resolved.documents.allowedPhases, [PHASES[0]]);
  assert.equal(resolved.plannedClaims.owners[PHASES[2]], PHASES[0]);
  assert.equal(resolved.phases[3].testEvidenceFrom, PHASES[2]);
  assert.deepEqual(resolved.obligationGraph.findings, []);
  assert.ok(definition.mcpServers.playwright.agents.includes(AGENTS[1]));
  assert.ok(!definition.mcpServers.playwright.agents.includes(AGENTS[2]));
  assert.ok(!definition.mcpServers.playwright.phases.includes(PHASES[2]));
  for (const phase of resolved.phases) {
    const text = await readFile(path.join(root, definition.templatesRoot, phase.template), 'utf8');
    for (const heading of phase.artifact.validation.requiredHeadings) assert.ok(text.includes(`## ${heading}\n`), heading);
  }
  assert.deepEqual(resolveWorkType(definition, 'document-test-repair').phases.map((phase) => phase.id),
    ['document-intake', 'scenario-check', 'scenario-repair', 'scenario-retest']);
  assert.equal((await workflowCatalog(root)).find((entry) => entry.id === ID).status, 'current');
  const simulation = (await simulateWorkflow(root, ID))[0];
  assert.deepEqual(simulation.phases.map((phase) => phase.id), PHASES);
  assert.notEqual(simulation.lifecycle.status, 'invalid');
});

test('agent verdict and human approval agree on finish; defects and blocked access take bounded routes', async () => {
  const resolved = resolveWorkType(validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'))), ID);
  for (const [phase, verdict, kind, target] of [
    [PHASES[1], 'pass', 'end', null], [PHASES[1], 'repair', 'next', PHASES[2]],
    [PHASES[1], 'blocked', 'loop', PHASES[1]], [PHASES[3], 'pass', 'end', null],
    [PHASES[3], 'repair', 'loop', PHASES[2]], [PHASES[3], 'blocked', 'loop', PHASES[3]]
  ]) {
    const workflow = aggregate(resolved, phase, verdict);
    const outcome = decisionOutcome(workflow, workflow.phases[phase]);
    assert.deepEqual([outcome.kind, outcome.target], [kind, target]);
  }
  for (const verdict of ['repair', 'blocked']) {
    const workflow = aggregate(resolved, PHASES[3], verdict, 2);
    const outcome = decisionOutcome(workflow, workflow.phases[PHASES[3]]);
    assert.equal(outcome.kind, 'pause');
    assert.equal(outcome.reason, 'limit');
    const pending = pendingDecisionRecord(workflow, workflow.phases[PHASES[3]], outcome, { at: '2026-10-07T00:00:00Z' });
    assert.ok(!pending.options.some((entry) => entry.to === 'end'));
    assert.throws(() => resolveDecisionChoice(workflow, { ...pending,
      options: [...pending.options, { id: 'accepted', label: 'Forged pass', to: 'end' }], values: { verdict: 'pass' }
    }, { option: 'accepted' }), (error) => error.code === 'DECISION_CONDITION_REQUIRED');
  }
  const workflow = aggregate(resolved, PHASES[1], 'pass');
  workflow.decisionLog = [decisionOutcome(workflow, workflow.phases[PHASES[1]])];
  assert.equal(applicabilityStatus(workflow)[0].satisfied, false);
  workflow.applicability = [{ responsibility: 'implement', authorityGroup: 'quality-reviewers', reason: 'Fresh web observations prove the existing behavior matches the approved screenshot and interactions.' }];
  assert.equal(applicabilityStatus(workflow)[0].satisfied, true);
});

test('custom skills reach only their agent phases and do not leak into other workflows', async (t) => {
  const root = await temporary(t);
  const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, ID);
  for (const [index, skill] of [[0, SKILLS[0]], [1, SKILLS[1]], [2, SKILLS[2]], [3, SKILLS[1]]]) {
    const rendered = await renderAgentSkills(root, { workItem: { id: 'WEB-1', workType: ID } },
      resolved.phases[index], { agent: resolved.phases[index].defaultAgent });
    assert.deepEqual(rendered.skills.map((entry) => entry.id), [skill]);
    assert.match(rendered.text, new RegExp(`skill: ${skill} sha256=`));
    assert.ok(rendered.text.includes((await loadSkillLibrary(root)).skills.get(skill).instructions));
  }
  const other = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'classic-delivery' } },
    { id: 'implementation' }, { agent: 'developer' });
  assert.deepEqual(other.skills, []);
  const testerElsewhere = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'document-test-repair' } },
    { id: 'scenario-check' }, { agent: AGENTS[1] });
  assert.deepEqual(testerElsewhere.skills, []);
});

test('install into an earlier repository adopts all dependencies, is dry-run safe and preserves customizations', async (t) => {
  const root = await temporary(t);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  delete config.workTypes[ID];
  for (const id of PHASES) delete config.phases[id];
  config.mcpServers.playwright.phases = config.mcpServers.playwright.phases.filter((id) => !PHASES.includes(id));
  config.mcpServers.playwright.agents = config.mcpServers.playwright.agents.filter((id) => !AGENTS.includes(id));
  await writeFile(configPath, YAML.stringify(config));
  await rm(path.join(root, 'singularity/skill-library'), { recursive: true });
  for (const id of AGENTS) await rm(path.join(root, `.github/agents/${id}.agent.md`));
  await rm(path.join(root, 'singularity/templates/demo-web-e2e-testing'), { recursive: true });
  const preview = await installWorkflow(root, ID, { dryRun: true });
  assert.ok(SKILLS.every((id) => preview.files.includes(librarySkillPath(id))));
  assert.equal((await loadDefinition(root)).workTypes[ID], undefined);
  await installWorkflow(root, ID);
  assert.deepEqual(resolveWorkType(await loadDefinition(root), ID).phases.map((phase) => phase.defaultAgent), [AGENTS[0], AGENTS[1], AGENTS[2], AGENTS[1]]);
  const skillPath = path.join(root, librarySkillPath(SKILLS[1]));
  const agentPath = path.join(root, `.github/agents/${AGENTS[1]}.agent.md`);
  const customSkill = `${await readFile(skillPath, 'utf8')}\nUse the team-specific browser fixture.\n`;
  const customAgent = `${await readFile(agentPath, 'utf8')}\nRespect the team's test environment.\n`;
  await writeFile(skillPath, customSkill); await writeFile(agentPath, customAgent);
  const attachments = `# Keep this team note.\n${await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8')}`;
  await writeFile(path.join(root, SKILL_ATTACHMENTS_PATH), attachments);
  await installWorkflow(root, ID, { replace: true });
  assert.equal(await readFile(skillPath, 'utf8'), customSkill);
  assert.equal(await readFile(agentPath, 'utf8'), customAgent);
  assert.equal(await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8'), attachments);
  assert.equal(parseSkillAttachments(attachments).length, 3);
});

test('workflow export and renamed import carry exact custom agents and attached skills', async (t) => {
  const source = await temporary(t);
  const bundle = await exportWorkflowBundle(source, [ID]);
  assert.deepEqual(bundle.assets.filter((entry) => entry.kind === 'skill').map((entry) => entry.id).sort(), [...SKILLS].sort());
  for (const id of SKILLS) assert.equal(bundle.assets.find((entry) => entry.kind === 'skill' && entry.id === id).content,
    await readFile(path.join(source, librarySkillPath(id)), 'utf8'));
  const target = await temporary(t);
  // An earlier repository has not adopted the demo and has no repository-owned demo agents.
  const targetConfigPath = path.join(target, 'singularity/workflow.yml');
  const targetConfig = YAML.parse(await readFile(targetConfigPath, 'utf8'));
  delete targetConfig.workTypes[ID];
  await writeFile(targetConfigPath, YAML.stringify(targetConfig));
  for (const id of AGENTS) await rm(path.join(target, `.github/agents/${id}.agent.md`));
  const resolutions = { [`workflow:${ID}`]: { action: 'rename', to: 'team-web-e2e' } };
  const plan = await planWorkflowImport(target, bundle, { resolutions });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions: plan.resolutions });
  const resolved = resolveWorkType(await loadDefinition(target), 'team-web-e2e');
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), [AGENTS[0], AGENTS[1], AGENTS[2], AGENTS[1]]);
  const rendered = await renderAgentSkills(target, { workItem: { id: 'TEAM-1', workType: 'team-web-e2e' } },
    resolved.phases[1], { agent: resolved.phases[1].defaultAgent });
  assert.deepEqual(rendered.skills.map((entry) => entry.id), [SKILLS[1]]);
});

test('starter dependency planning preserves unrelated attachments and cannot inject demo skills into another starter', async (t) => {
  const root = await temporary(t);
  const unrelated = { id: SKILLS[1], agent: 'qa', phases: ['verification'], use: 'Only for this team review' };
  const original = `# Keep the team annotation.\n${skillAttachmentsText([unrelated])}`;
  await writeFile(path.join(root, SKILL_ATTACHMENTS_PATH), original);
  const files = await packagedWorkflowSkills(root, ID, new Set(AGENTS));
  const planned = files.find((entry) => entry.path === SKILL_ATTACHMENTS_PATH).text;
  assert.match(planned, /^# Keep the team annotation\./);
  assert.ok(parseSkillAttachments(planned).some((entry) => entry.agent === 'qa' && entry.use === unrelated.use));
  assert.equal(parseSkillAttachments(planned).length, 4);
  assert.equal(await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8'), original, 'planning writes nothing');
  assert.deepEqual(await packagedWorkflowSkills(root, 'classic-delivery', new Set(['developer', 'qa'])), []);
  const skillPath = path.join(root, librarySkillPath(SKILLS[0]));
  await writeFile(skillPath, '---\nname: a-colliding-name\ndescription: Invalid identity\n---\nDo not silently replace me.\n');
  await assert.rejects(() => packagedWorkflowSkills(root, ID, new Set(AGENTS)), (error) => error.code === 'SKILL_LIBRARY_INVALID');
  assert.equal(await readFile(path.join(root, SKILL_ATTACHMENTS_PATH), 'utf8'), original);
});

test('CLI starts a real demo Story and retains custom skills in the accepted workflow snapshot', async (t) => {
  const root = await temporary(t);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Demo Web Reviewer',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: ID, agent: AGENTS[0] }) };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.name', 'Demo Web Reviewer']);
  run('git', ['config', 'user.email', 'demo-web@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Demo web fixture\n');
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  await writeFile(file, YAML.stringify(config));
  run('git', ['add', '.']); run('git', ['commit', '-m', 'Initialize demo web fixture']);
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-u', 'origin', 'main']);
  const cli = (...args) => run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', ...args]);
  cli('start', 'WEB-DEMO-1', '--from-branch', 'main', '--work-type', ID,
    '--title', 'Match the approved web screenshot', '--description', 'Check before repairing the approved web screen.');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/WEB-DEMO-1/workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phaseOrder, PHASES);
  const show = JSON.parse(cli('phase', 'show', PHASES[0], '--json'));
  assert.equal(show.policyVerified, true);
  assert.equal(show.effectiveAuthoringSkill, '/sf-document-intake');
  const manifest = JSON.parse(await readFile(path.join(root, workflow.workflowSnapshot.manifestPath), 'utf8'));
  for (const id of SKILLS) assert.ok(manifest.assets.some((entry) => entry.logicalId.endsWith(`:skill:${id}`)), id);
  assert.match(cli('nextsteps', '--json'), /sf-document-intake/);
});
